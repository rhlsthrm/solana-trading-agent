import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage } from "telegram/events";
import input from "input";
import { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";
import Database from "better-sqlite3";
import { JupiterService } from "./JupiterService";
import { TradeExecutionService } from "./TradeExecutionService";
import { ProficyService } from "./ProficyService";
import { SentimentAnalysisService } from "./SentimentAnalysisService";
import { randomUUID } from "../utils/uuid";

export const SignalSchema = z.object({
  isTradeSignal: z.boolean(),
  type: z.enum(["BUY", "SELL"]),
  confidence: z.number().min(0).max(100),
});

export interface EnhancedSignal {
  id: string;
  tokenAddress: string;
  type: "BUY" | "SELL";
  confidence: number;
  isTradeSignal: boolean;
  price?: number | null;
  volume24h?: number;
  liquidity?: number;
}

export class TelegramMonitorService {
  private client: TelegramClient;
  private channelIds: string[] = ["DegenSeals", "fadedarc", "goattests"];
  private lastMessageTime: number = Date.now();
  private isConnected: boolean = false;
  private readonly minLiquidity = 50000;
  private readonly minVolume = 10000;

  constructor(
    private config: {
      apiId: number;
      apiHash: string;
      sessionStr?: string;
      runtime: IAgentRuntime;
      db: Database.Database;
      jupiterService: JupiterService;
      tradeExecutionService: TradeExecutionService;
      proficyService: ProficyService;
      sentimentService: SentimentAnalysisService;
    }
  ) {
    const stringSession = new StringSession(config.sessionStr || "");
    this.client = new TelegramClient(
      stringSession,
      config.apiId,
      config.apiHash,
      {
        connectionRetries: 5,
      }
    );
  }

  async start() {
    try {
      await this.initializeTelegramClient();
      await this.setupMessageHandler();
      await this.verifyChannelAccess();
      this.startHealthCheck();
    } catch (error) {
      console.error("Error starting Telegram service:", error);
      throw error;
    }
  }

  private async reconnect() {
    console.log("🔄 Reconnecting to Telegram...");
    try {
      await this.client.disconnect();
      
      // Small delay to ensure clean disconnect
      await new Promise((resolve) => setTimeout(resolve, 1000));

      await this.client.connect();
      await this.setupMessageHandler();
      await this.verifyChannelAccess();

      this.isConnected = true;
      this.lastMessageTime = Date.now();
      console.log("✅ Reconnected successfully");
    } catch (error) {
      console.error("❌ Reconnection failed:", error);
      this.isConnected = false;

      // Try to reconnect again after a delay
      setTimeout(() => this.reconnect(), 30000);
    }
  }

  private startHealthCheck() {
    setInterval(async () => {
      const timeSinceLastMessage = Date.now() - this.lastMessageTime;
      
      // Only log if no message for over a minute
      if (timeSinceLastMessage > 60 * 1000) {
        console.log(`⏲️ No messages for ${Math.round(timeSinceLastMessage / 1000)}s`);
      }

      // Reduce the threshold to 2 minutes
      if (timeSinceLastMessage > 2 * 60 * 1000) {
        console.log("⚠️ No recent messages, checking connection...");
        try {
          const isAlive = await this.testConnection();
          if (!isAlive) {
            console.log("❌ Connection test failed, reconnecting...");
            await this.reconnect();
          }
        } catch (error) {
          console.error("❌ Health check failed:", error);
          await this.reconnect();
        }
      }
    }, 30000); // Check every 30 seconds
  }

  private async testConnection(): Promise<boolean> {
    try {
      // Try to get a message from the first channel
      const channel = this.channelIds[0];
      await this.client.getMessages(channel, { limit: 1 });
      return true;
    } catch (error) {
      console.error("Connection test failed:", error);
      return false;
    }
  }

  private async initializeTelegramClient() {
    await this.client.start({
      phoneNumber: async () => await input.text("Please enter your number: "),
      password: async () => await input.text("Please enter your password: "),
      phoneCode: async () =>
        await input.text("Please enter the code you received: "),
      onError: (err) => console.error("Telegram client error:", err),
    });
    console.log("Connected to Telegram");
  }

  private async setupMessageHandler() {
    this.client.addEventHandler(async (event: any) => {
      try {
        const message = event.message;
        if (!message?.text) return; // Skip if no text in message
        
        const chat = await message.getChat();

        // Update last message time for health check
        this.lastMessageTime = Date.now();
        this.isConnected = true;

        // Only process messages from monitored channels
        if (!this.channelIds.includes(chat.username)) {
          return;
        }

        try {
          const signal = await this.processMessage(message.text);
          if (signal?.isTradeSignal) {
            console.log("🚨 Trading Signal Detected:", {
              token: signal.tokenAddress,
              type: signal.type
            });

            const isValid = await this.validateSignal(signal);
            if (isValid) {
              await this.processValidSignal(signal);
            } else {
              console.log("❌ Signal rejected - failed validation");
            }
          }
        } catch (error) {
          console.error("Error processing signal:", error);
          // Don't rethrow - allow handler to continue
        }
      } catch (outerError) {
        console.error("Critical error in message handler:", outerError);
        // Don't rethrow - keep the event handler alive
      }
    }, new NewMessage({}));

    // Add heartbeat to verify handler is still running (less frequent)
    setInterval(() => {
      // No console logging for regular heartbeat
    }, 60000);
  }

  private readonly SOLANA_ADDRESS_REGEX =
    /(?<!\/)([1-9A-HJ-NP-Za-km-z]{32,44})(?!\/)/g;

  private async processMessage(
    message: string
  ): Promise<EnhancedSignal | null> {
    try {
      // First, try to extract a token address directly from the message
      const addressMatches = [...message.matchAll(this.SOLANA_ADDRESS_REGEX)];
      let tokenAddress = null;

      if (addressMatches.length > 0) {
        // Use the first address found in the message
        tokenAddress = addressMatches[0][0];
      }

      // If we found a token address in the message, use it with Proficy for more info
      let tokenInfo;
      if (tokenAddress) {
        tokenInfo = await this.config.proficyService.getTokenInfo(tokenAddress);
      } else {
        // If no direct address found, let Proficy try to extract it from the full message
        tokenInfo = await this.config.proficyService.getTokenInfo(message);
      }

      if (!tokenInfo?.isValid) {
        return null;
      }

      // 2. Analyze sentiment
      const sentiment = await this.config.sentimentService.analyzeSentiment(
        message
      );

      if (!sentiment) {
        return null;
      }

      // 3. Create enhanced signal
      return {
        id: randomUUID(),
        tokenAddress: tokenInfo.address,
        type: "BUY",
        confidence: sentiment.confidence || 70,
        isTradeSignal: true,
        price: tokenInfo.price || null,
        volume24h: tokenInfo.volume24h || 0,
        liquidity: tokenInfo.liquidity || 0,
      };
    } catch (error) {
      console.error("Error processing message:", error);
      return null;
    }
  }

  private async verifyChannelAccess() {
    for (const channelId of this.channelIds) {
      try {
        await this.client.getMessages(channelId, { limit: 1 });
      } catch (error) {
        console.error(`❌ Error accessing ${channelId}:`, error);
        throw error;
      }
    }
    console.log(`✅ Connected to ${this.channelIds.length} channels`);
  }

  private async validateSignal(signal: EnhancedSignal): Promise<boolean> {
    try {
      if (signal.liquidity && signal.liquidity < this.minLiquidity) {
        // Log reason for signal rejection but less verbose
        return false;
      }

      if (signal.volume24h && signal.volume24h < this.minVolume) {
        // Log reason for signal rejection but less verbose
        return false;
      }

      const recentTrade = this.config.db
        .prepare(
          `
          SELECT * FROM trades 
          WHERE token_address = ? 
          AND entry_time > unixepoch() - 86400
          AND status = 'EXECUTED'  -- Only count successful trades
      `
        )
        .get(signal.tokenAddress);

      if (recentTrade) {
        // Already traded recently
        return false;
      }

      await this.storeSignal(signal);
      return true;
    } catch (error) {
      console.error("Error validating signal:", error);
      return false;
    }
  }

  private async storeSignal(signal: EnhancedSignal) {
    const stmt = this.config.db.prepare(`
     INSERT INTO signals (
       id,
       source,
       token_address,
       signal_type,
       price,
       timestamp,
       processed,
       confidence,
       liquidity,
       volume_24h
     ) VALUES (?, ?, ?, ?, ?, unixepoch(), 0, ?, ?, ?)
   `);

    stmt.run(
      signal.id,
      "@DegenSeals",
      signal.tokenAddress,
      signal.type,
      signal.price || 0,
      signal.confidence || 50,
      signal.liquidity || 0,
      signal.volume24h || 0
    );
  }

  private async processValidSignal(signal: EnhancedSignal) {
    console.log("✅ Valid signal detected for token:", signal.tokenAddress);

    const success = await this.config.tradeExecutionService.executeTrade(
      signal
    );
    if (success) {
      console.log("🎯 Trade executed successfully for", signal.tokenAddress);
    } else {
      console.log("❌ Trade execution failed for", signal.tokenAddress);
    }
  }
}

export const createTelegramMonitorService = (config: {
  apiId: number;
  apiHash: string;
  sessionStr?: string;
  runtime: IAgentRuntime;
  db: Database.Database;
  jupiterService: JupiterService;
  tradeExecutionService: TradeExecutionService;
  proficyService: ProficyService;
  sentimentService: SentimentAnalysisService;
}) => {
  return new TelegramMonitorService(config);
};
