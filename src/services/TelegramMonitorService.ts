// telegram.ts
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage } from "telegram/events";
import input from "input";
import { IAgentRuntime } from "@ai16z/eliza";
import { z } from "zod";
import Database from "better-sqlite3";
import { JupiterService } from "./JupiterService";
import { TradeExecutionService } from "./TradeExecutionService";
import {
  EnhancedSignal,
  parseSignalWithClaude,
} from "../utils/parseSignalWithClaude";
import { ProficyService } from "./ProficyService";

// Enhanced signal schema with more trading-specific fields
export const SignalSchema = z.object({
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
  private channelIds: string[] = ["DegenSeals", "fadedarc", "goattests"];
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
      proficyService: ProficyService; // Added ProficyService
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
    // console.log(
    //   "Session string (save to TELEGRAM_SESSION in .env):",
    //   this.client.session.save()
    // );
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
        const signal = await parseSignalWithClaude(
          message.text,
          this.config.runtime,
          this.config.proficyService
        );

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

  private async validateSignal(signal: EnhancedSignal): Promise<boolean> {
    try {
      // Check minimum liquidity
      if (signal.liquidity && signal.liquidity < this.minLiquidity) {
        console.log(`❌ Insufficient liquidity: $${signal.liquidity}`);
        return false;
      }

      // Check minimum volume
      if (signal.volume24h && signal.volume24h < this.minVolume) {
        console.log(`❌ Insufficient 24h volume: $${signal.volume24h}`);
        return false;
      }

      // Check if we've already traded this token recently
      const recentTrade = this.config.db
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

    const tradeSignal = {
      id: signal.id,
      tokenAddress: signal.tokenAddress,
      type: signal.type,
      price: signal.price,
      confidence: signal.confidence || 50,
    };

    const success = await this.config.tradeExecutionService.executeTrade(
      tradeSignal
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
}) => {
  return new TelegramMonitorService(config);
};
