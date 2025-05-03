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
    // Handle sell signals differently from buy signals
    if (signal.type === "SELL") {
      return this.executeSellTrade(signal);
    } else {
      return this.executeBuyTrade(signal);
    }
  }

  private async executeBuyTrade(signal: any): Promise<boolean> {
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
      console.error("Buy trade execution failed:", error);
      return false;
    }
  }

  private async executeSellTrade(signal: any): Promise<boolean> {
    try {
      // Check for existing position
      const position = await this.positionManager.getPositionByToken(
        signal.tokenAddress
      );

      if (!position) {
        console.log(`No position found for ${signal.tokenAddress} to sell`);
        return false;
      }

      // Get trading decision based on signal and current position
      const decision = await this.getSellDecision(signal, position);

      if (!decision.shouldSell) {
        console.log(
          `Decision not to sell ${signal.tokenAddress}: ${decision.reasoning}`
        );
        return false;
      }

      console.log(
        `💰 Executing sell for ${signal.tokenAddress} with reason: ${decision.reasoning}`
      );

      // Use the PositionManager's closePosition functionality
      const success = await this.positionManager.closePositionByToken(
        signal.tokenAddress
      );

      if (success) {
        console.log(`✅ Successfully sold position in ${signal.tokenAddress}`);

        // Update the signal record to mark it as processed
        this.db
          .prepare(`UPDATE signals SET processed = 1 WHERE id = ?`)
          .run(signal.id);

        return true;
      } else {
        console.error(`❌ Failed to sell position in ${signal.tokenAddress}`);
        return false;
      }
    } catch (error) {
      console.error("Sell trade execution failed:", error);
      return false;
    }
  }

  private async getSellDecision(
    signal: any,
    position: any
  ): Promise<{ shouldSell: boolean; reasoning: string }> {
    const SellDecisionSchema = z.object({
      shouldSell: z.boolean(),
      reasoning: z.string(),
    });

    try {
      // If we don't have current price information, get it
      const currentPrice =
        signal.price ||
        (await this.jupiterService.getCurrentPrice(signal.tokenAddress)) ||
        position.currentPrice;

      // Calculate profit or loss based on available data
      const entryPrice = position.entryPrice || 0;
      const changePercentage =
        entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;

      const prompt = `
      You are a cryptocurrency trading bot deciding whether to sell a token position.
      
      Position details:
      - Token address: ${signal.tokenAddress}
      - Entry price: ${position.entryPrice}
      - Current price: ${currentPrice}
      - Current profit/loss: ${changePercentage.toFixed(2)}%
      
      Signal details:
      - Signal type: ${signal.type}
      - Confidence: ${signal.confidence || "Unknown"}
      - Pump detected: ${signal.pumpDetected ? "Yes" : "No"}
      - Pump multiplier: ${signal.pumpMultiplier || "Unknown"}
      - Is update message: ${signal.isUpdateMessage ? "Yes" : "No"}
      
      Selling rules:
      - Always sell if profit is over 50%
      - Always sell if a large pump (5x+) is detected and we've held the position for some time
      - Always sell if the signal is explicitly a SELL signal with high confidence
      - Consider selling if profit is over 30% and pump is slowing down
      - Don't sell if we're at a loss unless the token is crashing and likely to lose more value
      
      Should I sell this position? Return a boolean decision and your reasoning.
      `;

      const result = await generateObject({
        runtime: this.runtime,
        context: prompt,
        modelClass: ModelClass.LARGE,
        schema: SellDecisionSchema,
        mode: "auto",
      });

      return result.object as z.infer<typeof SellDecisionSchema>;
    } catch (error) {
      console.error("Error getting sell decision:", error);
      // Default to not selling if we encounter an error in decision-making
      return {
        shouldSell: false,
        reasoning: "Error in decision process, defaulting to hold position",
      };
    }
  }

  private async getPositionSize(signal: any, balance: number): Promise<number> {
    // Extract the buySignalStrength if available, or fall back to confidence
    const buyStrength = signal.buySignalStrength || signal.confidence || 50;

    // Calculate the max percentage of balance to use based on buyStrength
    // Minimum 0.5%, maximum 5%
    const maxPercentage = 0.5 + (buyStrength / 100) * 4.5;

    // Calculate the base position size as a percentage of the balance
    const basePositionSize = balance * (maxPercentage / 100);

    // Adjust for token liquidity and volume
    let adjustedSize = basePositionSize;

    // Reduce position size for low liquidity tokens
    if (signal.liquidity && signal.liquidity < 100000) {
      const liquidityFactor = Math.max(signal.liquidity / 100000, 0.5);
      adjustedSize *= liquidityFactor;
    }

    // Reduce position size for low volume tokens
    if (signal.volume24h && signal.volume24h < 50000) {
      const volumeFactor = Math.max(signal.volume24h / 50000, 0.5);
      adjustedSize *= volumeFactor;
    }

    // Ensure there's enough for gas fees (reserve at least 0.01 SOL)
    const minSolReserve = 10_000_000; // 0.01 SOL in lamports
    adjustedSize = Math.min(adjustedSize, balance - minSolReserve);

    // Don't allow negative position sizes
    adjustedSize = Math.max(adjustedSize, 0);

    // Round to an integer (lamports)
    const finalPositionSize = Math.floor(adjustedSize);

    return finalPositionSize;
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
