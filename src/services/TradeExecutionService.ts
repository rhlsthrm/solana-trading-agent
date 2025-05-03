import { generateObject, ModelClass, IAgentRuntime } from "@elizaos/core";
import { Database } from "better-sqlite3";
import { z } from "zod";
import { JupiterService } from "./JupiterService";
import { SolanaWalletClient } from "../types/trade";
import { PositionManager } from "./PositionManager";
import { randomUUID } from "../utils/uuid";

const PositionSizeSchema = z.object({
  lamports: z.number(),
  reasoning: z.string(),
});

type PositionSize = z.infer<typeof PositionSizeSchema>;

export class TradeExecutionService {
  private readonly WRAPPED_SOL = "So11111111111111111111111111111111111111112";

  constructor(
    private jupiterService: JupiterService,
    private walletClient: SolanaWalletClient,
    private db: Database,
    private runtime: IAgentRuntime,
    private positionManager: PositionManager
  ) {}

  async executeTrade(signal: any): Promise<boolean> {
    try {
      // Start transaction
      this.db.exec("BEGIN TRANSACTION");

      try {
        // Check for existing position
        const existingPosition = await this.positionManager.getPositionByToken(
          signal.tokenAddress
        );
        if (existingPosition) {
          console.log(`Already have position in ${signal.tokenAddress}`);
          this.db.exec("ROLLBACK");
          return false;
        }

        // Get wallet balance
        const balance = await this.walletClient.balanceOf(
          this.walletClient.getAddress()
        );

        // Let AI decide position size
        const positionSize = await this.getPositionSize(
          signal,
          Number(balance.value)
        );

        // Get quote
        const quote = await this.jupiterService.getQuote({
          inputMint: this.WRAPPED_SOL,
          outputMint: signal.tokenAddress,
          amount: positionSize,
        });

        if (!quote) {
          this.db.exec("ROLLBACK");
          return false;
        }

        // Execute swap
        const result = await this.jupiterService.executeSwap(
          quote,
          this.walletClient
        );
        if (!result) {
          this.db.exec("ROLLBACK");
          return false;
        }

        // Record trade
        this.db
          .prepare(
            `
          INSERT INTO trades (
            id,
            token_address,
            position_size,
            entry_price,
            entry_time,
            status,
            signal_id,
            tx_id
          ) VALUES (?, ?, ?, ?, unixepoch(), ?, ?, ?)
        `
          )
          .run(
            randomUUID(),
            signal.tokenAddress,
            positionSize,
            signal.price,
            "EXECUTED",
            signal.id,
            result.txid
          );

        // Create position record
        await this.positionManager.createPosition({
          tokenAddress: signal.tokenAddress,
          amount: Number(quote.outAmount),
          entryPrice: signal.price,
        });

        // Commit transaction
        this.db.exec("COMMIT");

        console.log(`✅ Position created for ${signal.tokenAddress}`);
        return true;
      } catch (error) {
        // Rollback transaction on error
        this.db.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      console.error("Trade execution failed:", error);
      return false;
    }
  }

  private async getPositionSize(signal: any, balance: number): Promise<number> {
    const prompt = `
    You are a professional trader. Determine the position size in lamports for a trade with these parameters:
    - Available balance: ${balance} lamports
    - Token: ${signal.tokenAddress}
    - Price: ${signal.price}
    - Volume 24h: ${signal.volume24h}
    - Liquidity: ${signal.liquidity}
    - Confidence score: ${signal.confidence}

    Consider:
    - Never use more than 5% of balance
    - Higher confidence should mean larger position
    - Never risk the ability to pay gas fees
    - Leave room for slippage

    Return the position size in lamports as a number.
    Explain your reasoning.
    `;

    const result = await generateObject({
      runtime: this.runtime,
      context: prompt,
      modelClass: ModelClass.LARGE,
      schema: PositionSizeSchema,
      mode: "auto",
    });

    console.log("AI Position Sizing:", result.object);
    return (result.object as PositionSize).lamports;
  }
}

export const createTradeExecutionService = (
  jupiterService: JupiterService,
  walletClient: SolanaWalletClient,
  db: Database,
  runtime: IAgentRuntime,
  positionManager: PositionManager
) => {
  return new TradeExecutionService(
    jupiterService,
    walletClient,
    db,
    runtime,
    positionManager
  );
};
