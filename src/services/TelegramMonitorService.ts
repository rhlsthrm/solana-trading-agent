import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage } from "telegram/events";
import input from "input";
import { IAgentRuntime } from "@ai16z/eliza";
import { z } from "zod";
import Database from "better-sqlite3";
import { JupiterService } from "./JupiterService";
import { TradeExecutionService } from "./TradeExecutionService";
import { ProficyService } from "./ProficyService";
import { SentimentAnalysisService } from "./SentimentAnalysisService";
import { generateId } from "../utils/uuid";

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
  price?: number;
  volume24h?: number;
  liquidity?: number;
}

export class TelegramMonitorService {
  private client: TelegramClient;
  private channelIds: string[] = ["DegenSeals", "fadedarc", "goattests"];
  private lastMessageTime: number = Date.now();
  private readonly RECONNECT_INTERVAL = 5 * 60 * 1000; // 5 minutes
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
      console.log("Monitoring channels:", this.channelIds);
    } catch (error) {
      console.error("Error starting Telegram service:", error);
      throw error;
    }
  }

  private async reconnect() {
    console.log("🔄 Attempting to reconnect...");
    try {
      await this.client.disconnect();
      console.log("Disconnected old client");

      // Small delay to ensure clean disconnect
      await new Promise((resolve) => setTimeout(resolve, 1000));

      await this.client.connect();
      console.log("Connected new client");

      await this.setupMessageHandler();
      console.log("Set up new message handler");

      await this.verifyChannelAccess();
      console.log("Verified channel access");

      this.isConnected = true;
      this.lastMessageTime = Date.now();
      console.log("✅ Successfully reconnected!");
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
      console.log(
        `⏲️ Time since last message: ${Math.round(
          timeSinceLastMessage / 1000
        )}s`
      );

      // Reduce the threshold to 2 minutes
      if (timeSinceLastMessage > 2 * 60 * 1000) {
        console.log("⚠️ No recent messages, checking connection...");
        try {
          const isAlive = await this.testConnection();
          if (!isAlive) {
            console.log("❌ Connection test failed, forcing reconnect...");
            await this.reconnect();
          } else {
            console.log("✅ Connection test passed");
          }
        } catch (error) {
          console.error("❌ Health check failed:", error);
          await this.reconnect();
        }
      }
    }, 30000); // Check every 30 seconds instead of every minute
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
      console.log("🔍 Raw event received:", event?.message?.text);
      try {
        const message = event.message;
        const chat = await message.getChat();

        console.log("📝 Got chat:", chat.username);

        // Update last message time for health check
        this.lastMessageTime = Date.now();
        this.isConnected = true;

        if (!this.channelIds.includes(chat.username)) {
          console.log(
            `Skipping message from non-monitored channel: ${chat.username}`
          ); // Add this
          return;
        }

        try {
          const signal = await this.processMessage(message.text);
          console.log("signal", signal);
          if (signal?.isTradeSignal) {
            console.log("🚨 Trading Signal Detected!", {
              token: signal.tokenAddress,
              type: signal.type,
              price: signal.price,
              liquidity: signal.liquidity,
              volume: signal.volume24h,
            });

            const isValid = await this.validateSignal(signal);
            if (isValid) {
              await this.processValidSignal(signal);
            } else {
              console.log("❌ Signal rejected - failed validation checks");
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

    // Add heartbeat to verify handler is still running
    setInterval(() => {
      console.log("🏓 Message handler heartbeat");
    }, 60000); // Log every minute
  }

  private async processMessage(
    message: string
  ): Promise<EnhancedSignal | null> {
    // 1. Get token info from Proficy
    const tokenInfo = await this.config.proficyService.getTokenInfo(message);
    if (!tokenInfo?.isValid) {
      console.log("No valid token found");
      return null;
    }

    // 2. Analyze sentiment
    const sentiment = await this.config.sentimentService.analyzeSentiment(
      message
    );
    console.log("sentiment", sentiment);

    if (!sentiment) {
      console.log("Failed to analyze sentiment");
      return null;
    }

    // 3. Create enhanced signal
    return {
      id: generateId(),
      tokenAddress: tokenInfo.address,
      type: "BUY",
      confidence: sentiment.confidence || 70,
      isTradeSignal: true,
      price: tokenInfo.price,
      volume24h: tokenInfo.volume24h,
      liquidity: tokenInfo.liquidity,
    };
  }

  private async verifyChannelAccess() {
    for (const channelId of this.channelIds) {
      try {
        await this.client.getMessages(channelId, { limit: 1 });
        console.log(`✅ Successfully connected to ${channelId}`);
      } catch (error) {
        console.error(`❌ Error accessing ${channelId}:`, error);
        throw error;
      }
    }
  }

  private async validateSignal(signal: EnhancedSignal): Promise<boolean> {
    try {
      if (signal.liquidity && signal.liquidity < this.minLiquidity) {
        console.log(`❌ Insufficient liquidity: $${signal.liquidity}`);
        return false;
      }

      if (signal.volume24h && signal.volume24h < this.minVolume) {
        console.log(`❌ Insufficient 24h volume: $${signal.volume24h}`);
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
        console.log("❌ Already traded this token in the last 24h");
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
    console.log("✅ Valid signal detected!");
    console.log(JSON.stringify(signal, null, 2));

    const success = await this.config.tradeExecutionService.executeTrade(
      signal
    );
    if (success) {
      console.log("🎯 Trade executed successfully");
    } else {
      console.log("❌ Trade execution failed");
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
