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
  isUpdateMessage?: boolean;
  pumpDetected?: boolean;
  pumpMultiplier?: number;
  buySignalStrength?: number;
  urgencyLevel?: "low" | "medium" | "high";
  reasonForBuy?: string;
  tokenInfo?: any;
}

// Interface for positions (used for sell detection)
interface Position {
  tokenAddress: string;
  amount: number;
  entryPrice: number | null;
  entryTime?: number;
}

export class TelegramMonitorService {
  private client: TelegramClient;
  private channelIds: string[] = [
    "DegenSeals",
    "fadedarc",
    "-1002295400686", // giga
    "-1002032554589", // onchain apes
    "-1002216963577", // crip toe
    // "-1002298010840", // matrix core
    "-1002495942635", // happy profit chat
    "-1001554026478", // investing beanstock dao
    "-1002226331852",
  ];
  private lastMessageTime: number = Date.now();
  private isConnected: boolean = false;
  private readonly minVolume = 10000;

  // Token mention tracking for better context analysis
  private tokenMentions: Map<
    string,
    {
      lastMentioned: number;
      mentionCount: number;
      firstSeenPrice?: number;
      lastSeenPrice?: number;
      priceHistory: Array<{ timestamp: number; price: number }>;
    }
  > = new Map();

  // Cache of our positions to avoid repeated DB queries
  private positionsCache: Map<string, Position> = new Map();

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
      await this.initializePositionsCache();
      this.startHealthCheck();
      this.startPositionsCacheRefresh();
    } catch (error) {
      console.error("Error starting Telegram service:", error);
      throw error;
    }
  }

  private async initializePositionsCache() {
    try {
      // Get all active positions from the positions table
      const positions = this.config.db
        .prepare(
          `
          SELECT * FROM positions
          WHERE status = 'ACTIVE'
        `
        )
        .all() as Position[];

      // Store in cache
      positions.forEach((position) => {
        this.positionsCache.set(position.tokenAddress, position);
      });
    } catch (error) {
      console.error("Error initializing positions cache:", error);
      // Non-critical error, we'll continue with an empty cache
    }
  }

  private startPositionsCacheRefresh() {
    // Refresh the positions cache every 5 minutes
    setInterval(async () => {
      await this.initializePositionsCache();
    }, 5 * 60 * 1000);
  }

  private async checkForExistingPosition(
    tokenAddress: string
  ): Promise<Position | null> {
    try {
      // First check cache
      if (this.positionsCache.has(tokenAddress)) {
        return this.positionsCache.get(tokenAddress) || null;
      }

      // If not in cache, check DB directly (and update cache)
      const position = this.config.db
        .prepare(
          `
          SELECT * FROM positions
          WHERE token_address = ? AND status = 'ACTIVE'
        `
        )
        .get(tokenAddress) as Position | undefined;

      if (position) {
        // Update cache
        this.positionsCache.set(tokenAddress, position);
        return position;
      }

      return null;
    } catch (error) {
      console.error("Error checking for existing position:", error);
      return null;
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

      // Reduce the threshold to 2 minutes
      if (timeSinceLastMessage > 2 * 60 * 1000) {
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
    }, 30000);
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
        if (
          !this.channelIds.includes(chat.username) &&
          !this.channelIds.map((id) => id.slice(4)).includes(chat.id.toString()) // remove the -100 part
        ) {
          return;
        }

        try {
          const signal = await this.processMessage(message.text);
          if (signal?.isTradeSignal) {
            console.log("🚨 Trading Signal Detected:", {
              token: signal.tokenAddress,
              type: signal.type,
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

  private updateTokenMentionHistory(
    tokenAddress: string,
    price: number | null
  ): {
    isFirstMention: boolean;
    priceChange: number;
    timeSinceLastMention: number;
    numberOfMentions: number;
  } {
    const now = Date.now();
    const existingData = this.tokenMentions.get(tokenAddress);

    if (!existingData) {
      // First time seeing this token
      this.tokenMentions.set(tokenAddress, {
        lastMentioned: now,
        mentionCount: 1,
        firstSeenPrice: price || undefined,
        lastSeenPrice: price || undefined,
        priceHistory: price ? [{ timestamp: now, price }] : [],
      });

      return {
        isFirstMention: true,
        priceChange: 0,
        timeSinceLastMention: 0,
        numberOfMentions: 1,
      };
    } else {
      // Update existing token data
      const timeSinceLastMention = now - existingData.lastMentioned;
      const newMentionCount = existingData.mentionCount + 1;

      // Calculate price change if we have price data
      let priceChange = 0;
      if (price && existingData.firstSeenPrice) {
        priceChange = (price / existingData.firstSeenPrice - 1) * 100; // as percentage
      }

      // Update the token mention data
      this.tokenMentions.set(tokenAddress, {
        lastMentioned: now,
        mentionCount: newMentionCount,
        firstSeenPrice: existingData.firstSeenPrice || price || undefined,
        lastSeenPrice: price || existingData.lastSeenPrice,
        priceHistory: [
          ...existingData.priceHistory,
          ...(price ? [{ timestamp: now, price }] : []),
        ],
      });

      return {
        isFirstMention: false,
        priceChange,
        timeSinceLastMention,
        numberOfMentions: newMentionCount,
      };
    }
  }

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

      // Update token mention history and get context about previous mentions
      const mentionContext = this.updateTokenMentionHistory(
        tokenInfo.address,
        tokenInfo.price || null
      );

      // 2. Analyze sentiment with enhanced analysis
      const sentiment = await this.config.sentimentService.analyzeSentiment(
        message
      );
      if (!sentiment) {
        return null;
      }

      // Try to get enhanced sentiment analysis
      const enhancedSentiment =
        await this.config.sentimentService.analyzeEnhancedSentiment(message);

      // Check if we already have a position for this token
      // This will determine if we should consider selling
      const existingPosition = await this.checkForExistingPosition(
        tokenInfo.address
      );

      // Signal type will depend on context of the message and our position
      let signalType = "BUY"; // Default to buy

      // If we have our own opinion on whether this should be a sell signal based on pump size
      let shouldBeConsideredSell = false;

      // Create enhanced signal with additional details if available
      const signal: EnhancedSignal = {
        id: randomUUID(),
        tokenAddress: tokenInfo.address,
        type: signalType as "BUY" | "SELL", // Will be updated below
        confidence: sentiment.confidence || 70,
        isTradeSignal: sentiment.isTradeSignal,
        price: tokenInfo.price || null,
        volume24h: tokenInfo.volume24h || 0,
        liquidity: tokenInfo.liquidity || 0,
        tokenInfo: tokenInfo,
      };

      // Add enhanced sentiment data if available
      if (enhancedSentiment) {
        // If this is not the first mention and the AI didn't detect an update,
        // but we know it's been mentioned before, mark it as an update
        const isLikelyUpdate =
          !mentionContext.isFirstMention &&
          mentionContext.timeSinceLastMention < 12 * 60 * 60 * 1000; // Within 12 hours

        signal.isUpdateMessage =
          enhancedSentiment.isUpdateMessage || isLikelyUpdate;

        // If we detected a price increase but the AI didn't detect a pump,
        // use our data to determine if it's pumped
        const hasPumped = mentionContext.priceChange > 100; // Over 100% increase is a pump
        signal.pumpDetected = enhancedSentiment.pumpDetected || hasPumped;

        // Calculate pump multiplier from our data if AI didn't provide it
        let pumpMultiplier = enhancedSentiment.pumpMultiplier;
        if (hasPumped && !pumpMultiplier) {
          pumpMultiplier = mentionContext.priceChange / 100 + 1; // Convert percentage to multiplier
        }
        signal.pumpMultiplier = pumpMultiplier;

        signal.buySignalStrength = enhancedSentiment.buySignalStrength;
        signal.urgencyLevel = enhancedSentiment.urgencyLevel;
        signal.reasonForBuy = enhancedSentiment.reasonForBuy;

        // SELL SIGNAL DETECTION LOGIC
        // If the AI detected this as a sell signal, respect that
        if (enhancedSentiment.type === "SELL") {
          shouldBeConsideredSell = true;
        }

        // Large pumps (5x+) should be considered sell signals if we own the token
        if ((pumpMultiplier || 0) >= 5 && existingPosition) {
          shouldBeConsideredSell = true;
          console.log(
            `💰 Detected large pump (${pumpMultiplier}x) for token we own - considering sell signal`
          );
        }

        // For 3-4x pumps, only consider it a sell signal if it's an update message AND we have a position
        // Messages about tokens with 3-4x pumps can still be buy signals if we don't already own them
        if (
          signal.isUpdateMessage &&
          (pumpMultiplier || 0) >= 3 &&
          (pumpMultiplier || 0) < 5 &&
          existingPosition
        ) {
          shouldBeConsideredSell = true;
          console.log(
            `📈 Update message with significant gains (${pumpMultiplier}x) on owned token - considering sell signal`
          );
        }

        // Messages indicating a 3-4x pump on tokens we DON'T own should remain BUY signals
        if (
          (pumpMultiplier || 0) >= 3 &&
          (pumpMultiplier || 0) < 5 &&
          !existingPosition
        ) {
          console.log(
            `🔄 Keeping as BUY signal for ${pumpMultiplier}x token we don't own yet`
          );
        }

        // Update the signal type based on our analysis
        if (shouldBeConsideredSell) {
          signal.type = "SELL";

          // Mark this as a sell signal
          console.log(
            `🔄 Converting to SELL signal for ${
              tokenInfo.symbol || tokenInfo.address
            }`
          );
        } else {
          signal.type = enhancedSentiment.type || "BUY";
        }

        // Log compact signal summary
        console.log(
          `📊 Signal: ${signal.type} ${
            tokenInfo.symbol || tokenInfo.address
          } | Pump: ${
            signal.pumpDetected ? `${signal.pumpMultiplier}x` : "No"
          } | Urgency: ${signal.urgencyLevel || "normal"}`
        );
      }

      return signal;
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
    console.log(`✅ Monitoring ${this.channelIds.length} channels`);
  }

  private async validateSignal(signal: EnhancedSignal): Promise<boolean> {
    try {
      // Capture rejection reason for better logging
      let rejectionReason = "";

      // For SELL signals, we only care if we have a position
      if (signal.type === "SELL") {
        // Check if we have a position for this token
        const position = await this.checkForExistingPosition(
          signal.tokenAddress
        );

        if (!position) {
          await this.storeSignal(signal);
          console.log(`ℹ️ No position to sell for ${signal.tokenAddress}`);
          return false;
        }

        // Sell signals are valid if we have a position
        await this.storeSignal(signal);
        console.log(`💰 Valid SELL signal for ${signal.tokenAddress}`);
        return true;
      }

      // Basic volume check
      if (signal.volume24h && signal.volume24h < this.minVolume) {
        console.log(`❌ Rejected: Low volume ($${signal.volume24h})`);
        return false;
      }

      // Check for recent trades of the same token
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
        console.log(`❌ Rejected: Already traded in last 24h`);
        return false;
      }

      // Log a simple acceptance message
      console.log(
        `✅ Accepting ${signal.type} signal for ${signal.tokenAddress}`
      );

      await this.storeSignal(signal);
      return true;
    } catch (error) {
      console.error("Error validating signal:", error);
      return false;
    }
  }

  private async storeSignal(signal: EnhancedSignal) {
    try {
      // First, make sure the signals table has the new columns
      // Note: Uses a transaction to ensure atomicity
      // Check and add columns one at a time with proper error handling
      try {
        // Check if is_update_message column exists, add if not
        const isUpdateMessageCheck = this.config.db
          .prepare(
            "SELECT COUNT(*) as count FROM pragma_table_info('signals') WHERE name='is_update_message'"
          )
          .get() as { count: number };

        if (isUpdateMessageCheck.count === 0) {
          this.config.db
            .prepare(
              "ALTER TABLE signals ADD COLUMN is_update_message BOOLEAN DEFAULT 0"
            )
            .run();
        }

        // Check if pump_detected column exists, add if not
        const pumpDetectedCheck = this.config.db
          .prepare(
            "SELECT COUNT(*) as count FROM pragma_table_info('signals') WHERE name='pump_detected'"
          )
          .get() as { count: number };

        if (pumpDetectedCheck.count === 0) {
          this.config.db
            .prepare(
              "ALTER TABLE signals ADD COLUMN pump_detected BOOLEAN DEFAULT 0"
            )
            .run();
        }

        // Check if pump_multiplier column exists, add if not
        const pumpMultiplierCheck = this.config.db
          .prepare(
            "SELECT COUNT(*) as count FROM pragma_table_info('signals') WHERE name='pump_multiplier'"
          )
          .get() as { count: number };

        if (pumpMultiplierCheck.count === 0) {
          this.config.db
            .prepare(
              "ALTER TABLE signals ADD COLUMN pump_multiplier REAL DEFAULT 0"
            )
            .run();
        }

        // Check if buy_signal_strength column exists, add if not
        const buySignalStrengthCheck = this.config.db
          .prepare(
            "SELECT COUNT(*) as count FROM pragma_table_info('signals') WHERE name='buy_signal_strength'"
          )
          .get() as { count: number };

        if (buySignalStrengthCheck.count === 0) {
          this.config.db
            .prepare(
              "ALTER TABLE signals ADD COLUMN buy_signal_strength INTEGER DEFAULT 0"
            )
            .run();
        }

        // Check if urgency_level column exists, add if not
        const urgencyLevelCheck = this.config.db
          .prepare(
            "SELECT COUNT(*) as count FROM pragma_table_info('signals') WHERE name='urgency_level'"
          )
          .get() as { count: number };

        if (urgencyLevelCheck.count === 0) {
          this.config.db
            .prepare(
              "ALTER TABLE signals ADD COLUMN urgency_level TEXT DEFAULT NULL"
            )
            .run();
        }

        // Check if reason_for_buy column exists, add if not
        const reasonForBuyCheck = this.config.db
          .prepare(
            "SELECT COUNT(*) as count FROM pragma_table_info('signals') WHERE name='reason_for_buy'"
          )
          .get() as { count: number };

        if (reasonForBuyCheck.count === 0) {
          this.config.db
            .prepare(
              "ALTER TABLE signals ADD COLUMN reason_for_buy TEXT DEFAULT NULL"
            )
            .run();
        }
      } catch (error) {
        console.error("Error modifying table schema:", error);
        // Continue and try to insert anyway
      }

      // Now insert with the enhanced fields
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
         volume_24h,
         is_update_message,
         pump_detected,
         pump_multiplier,
         buy_signal_strength,
         urgency_level,
         reason_for_buy
       ) VALUES (?, ?, ?, ?, ?, unixepoch(), 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     `);

      stmt.run(
        signal.id,
        "@DegenSeals",
        signal.tokenAddress,
        signal.type,
        signal.price || 0,
        signal.confidence || 50,
        signal.liquidity || 0,
        signal.volume24h || 0,
        signal.isUpdateMessage ? 1 : 0,
        signal.pumpDetected ? 1 : 0,
        signal.pumpMultiplier || 0,
        signal.buySignalStrength || 0,
        signal.urgencyLevel || null,
        signal.reasonForBuy || null
      );
    } catch (error) {
      console.error("Error storing signal:", error);
      // Continue execution rather than throwing - this is a non-critical operation
    }
  }

  private async processValidSignal(signal: EnhancedSignal) {
    // Different handling based on signal type
    if (signal.type === "SELL") {
      console.log(
        "💰 Valid SELL signal detected for token:",
        signal.tokenAddress
      );

      // Don't wait for this future update to TradeExecutionService
      // This would be implemented in the next task
      this.handleSellSignal(signal);
    } else {
      console.log(
        "✅ Valid BUY signal detected for token:",
        signal.tokenAddress
      );

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

  // Handle sell signals by executing the trade via TradeExecutionService
  private async handleSellSignal(signal: EnhancedSignal) {
    try {
      console.log(`🔄 Executing SELL signal for ${signal.tokenAddress}`);

      const success = await this.config.tradeExecutionService.executeTrade(
        signal
      );

      if (success) {
        console.log(`✅ Successfully sold position in ${signal.tokenAddress}`);
      } else {
        console.log(`❌ Failed to sell position in ${signal.tokenAddress}`);
      }

      // Mark the signal as processed
      this.config.db
        .prepare(`UPDATE signals SET processed = 1 WHERE id = ?`)
        .run(signal.id);
    } catch (error) {
      console.error("Error handling sell signal:", error);
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
