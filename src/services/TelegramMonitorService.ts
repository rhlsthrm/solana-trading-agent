// telegram.ts
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage } from "telegram/events";
import input from "input";
import { IAgentRuntime, generateObject, ModelClass } from "@ai16z/eliza";
import { z } from "zod";
import Database from "better-sqlite3";
import { JupiterService } from "./JupiterService";
import { TradeExecutionService } from "./TradeExecutionService";
import { generateId } from "ai";
import {
  EnhancedSignal,
  SignalExtractionType,
} from "../utils/parseSignalWithClaude";
import { SIGNAL_EXTRACTION_PROMPT } from "../utils/prompts";

// Enhanced signal schema with more trading-specific fields
const SignalSchema = z.object({
  isTradeSignal: z.boolean(),
  type: z.enum(["BUY", "SELL", "UNKNOWN"]),
  tokenAddress: z.string().optional(),
  price: z.number().optional(),
  riskLevel: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
  confidence: z.number().min(0).max(100).optional(),
  timeframe: z.string().optional(),
  stopLoss: z.number().optional(),
  takeProfit: z.number().optional(),
  expectedSlippage: z.number().optional(),
  minimumLiquidity: z.number().optional(),
  entryType: z.enum(["MARKET", "LIMIT"]).optional(),
  tags: z.array(z.string()).optional(),
  analysis: z
    .object({
      technicalFactors: z.array(z.string()).optional(),
      riskFactors: z.array(z.string()).optional(),
      catalysts: z.array(z.string()).optional(),
    })
    .optional(),
});

type Signal = z.infer<typeof SignalSchema>;

export class TelegramMonitorService {
  private client: TelegramClient;
  private channelIds: string[] = ["DegenSeals", "goattests"];
  private runtime: IAgentRuntime;
  private db: Database.Database;
  private jupiterService: JupiterService;
  private tradeExecutionService: TradeExecutionService;
  private readonly minLiquidity = 50000; // $50k minimum liquidity
  private readonly minVolume = 10000; // $10k minimum 24h volume

  constructor(
    private config: {
      apiId: number;
      apiHash: string;
      sessionStr?: string;
      runtime: IAgentRuntime;
      db: Database.Database;
      jupiterService: JupiterService;
      tradeExecutionService: TradeExecutionService;
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
    this.runtime = config.runtime;
    this.db = config.db;
    this.jupiterService = config.jupiterService;
    this.tradeExecutionService = config.tradeExecutionService;
  }

  async start() {
    try {
      console.log("Starting Telegram monitor service...");

      await this.initializeTelegramClient();
      await this.setupMessageHandler();
      await this.verifyChannelAccess();

      console.log("Monitoring channels:", this.channelIds);
    } catch (error) {
      console.error("Error starting Telegram service:", error);
      throw error;
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
    console.log(
      "Session string (save to TELEGRAM_SESSION in .env):",
      this.client.session.save()
    );
  }

  private async setupMessageHandler() {
    this.client.addEventHandler(async (event: any) => {
      const message = event.message;
      const chat = await message.getChat();

      if (!this.channelIds.includes(chat.username)) {
        return;
      }

      console.log(`📣 New message from ${chat.username}:`);
      console.log(message.text);

      try {
        const signal = await this.parseSignalWithClaude(message.text);
        console.log("signal", signal);

        if (signal?.isTradeSignal && signal.tokenAddress) {
          console.log("🚨 Trading Signal Detected!");

          // Validate the signal
          const isValid = await this.validateSignal(signal);
          console.log("isValid", isValid);

          if (isValid) {
            await this.processValidSignal(signal);
          } else {
            console.log("❌ Signal rejected - failed validation checks");
          }
        }
      } catch (error) {
        console.error("Error processing message:", error);
      }
    }, new NewMessage({}));
  }

  private async verifyChannelAccess() {
    for (const channelId of this.channelIds) {
      try {
        await this.client.getMessages(channelId, { limit: 1 });
        console.log(`✅ Successfully connected to ${channelId}`);
      } catch (error) {
        console.error(`❌ Error accessing ${channelId}:`, error);
        throw error; // Fail fast if we can't access our signal source
      }
    }
  }

  private async parseSignalWithClaude(
    text: string,
    idGenerator = generateId
  ): Promise<EnhancedSignal | null> {
    try {
      // First extract token address using regex as it's reliable
      const addressPattern = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;
      const addressMatch = text.match(addressPattern);
      if (!addressMatch) {
        return null;
      }
      const tokenAddress = addressMatch[0];

      // Add debug logging
      console.log("Attempting generateObject with runtime:", {
        modelProvider: this.runtime.modelProvider,
        hasToken: !!this.runtime.token,
        modelClass: ModelClass.LARGE, // Use LARGE instead of SMALL
      });

      // Use generateObject to extract structured data
      const result = await generateObject({
        runtime: this.runtime,
        context: SIGNAL_EXTRACTION_PROMPT.replace("{{text}}", text),
        modelClass: ModelClass.LARGE, // Changed from SMALL to LARGE
        schema: SignalSchema,
      });

      const extractedData = result.object as SignalExtractionType;

      // Construct enhanced signal
      const signal: EnhancedSignal = {
        id: idGenerator(),
        tokenAddress,
        isTradeSignal: true,
        ...extractedData,
      };

      return signal;
    } catch (error) {
      console.error("Error in parseSignalWithClaude:", error);
      console.error("Error details:", {
        modelProvider: this.runtime.modelProvider,
        hasToken: !!this.runtime.token,
        modelClass: ModelClass.LARGE,
      });
      return null;
    }
  }

  private async validateSignal(signal: Signal): Promise<boolean> {
    try {
      // Get token info from Jupiter
      const tokenInfo = await this.jupiterService.getTokenInfo(
        signal.tokenAddress!
      );
      if (!tokenInfo) {
        console.log("❌ Token not found on Jupiter");
        return false;
      }

      // Check minimum liquidity
      if (tokenInfo.liquidity < this.minLiquidity) {
        console.log(`❌ Insufficient liquidity: $${tokenInfo.liquidity}`);
        return false;
      }

      // Check minimum volume
      if (tokenInfo.volume24h < this.minVolume) {
        console.log(`❌ Insufficient 24h volume: $${tokenInfo.volume24h}`);
        return false;
      }

      // Check if we've already traded this token recently
      const recentTrade = this.db
        .prepare(
          `
        SELECT * FROM trades 
        WHERE token_address = ? 
        AND entry_time > unixepoch() - 86400
      `
        )
        .get(signal.tokenAddress);

      if (recentTrade) {
        console.log("❌ Already traded this token in the last 24h");
        return false;
      }

      // Store signal in database
      await this.storeSignal(signal, tokenInfo);

      return true;
    } catch (error) {
      console.error("Error validating signal:", error);
      return false;
    }
  }

  private async storeSignal(signal: Signal, tokenInfo: any) {
    const stmt = this.db.prepare(`
      INSERT INTO signals (
        id, 
        source,
        token_address,
        signal_type,
        price,
        timestamp,
        processed,
        risk_level,
        confidence,
        timeframe,
        stop_loss,
        take_profit,
        liquidity,
        volume_24h
      ) VALUES (?, ?, ?, ?, ?, unixepoch(), 0, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      crypto.randomUUID(),
      "@DegenSeals",
      signal.tokenAddress,
      signal.type,
      signal.price,
      signal.riskLevel,
      signal.confidence,
      signal.timeframe,
      signal.stopLoss,
      signal.takeProfit,
      tokenInfo.liquidity,
      tokenInfo.volume24h
    );
  }

  private async processValidSignal(signal: Signal) {
    console.log("✅ Valid signal detected!");
    console.log(JSON.stringify(signal, null, 2));

    // Validate required fields
    if (
      !signal.tokenAddress ||
      signal.type === "UNKNOWN" ||
      signal.confidence === undefined
    ) {
      console.log("❌ Missing required fields for trade execution");
      return;
    }

    // Transform signal to match trade execution requirements
    const tradeSignal = {
      id: crypto.randomUUID(), // Generate a unique ID for this signal
      tokenAddress: signal.tokenAddress,
      type: signal.type as "BUY" | "SELL", // We already checked it's not UNKNOWN
      price: signal.price,
      confidence: signal.confidence,
    };

    // Execute trade
    const success = await this.tradeExecutionService.executeTrade(tradeSignal);
    if (success) {
      console.log("🎯 Trade executed successfully");
    } else {
      console.log("❌ Trade execution failed");
    }
  }

  async stop() {
    try {
      console.log("Disconnecting from Telegram...");
      await this.client.disconnect();
      console.log("Cleanup completed successfully");
    } catch (error) {
      console.error("Error during cleanup:", error);
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
}) => {
  return new TelegramMonitorService(config);
};
