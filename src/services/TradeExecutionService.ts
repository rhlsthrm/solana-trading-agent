// src/services/trade-execution.ts
import { WalletClientBase } from "@goat-sdk/core";
import { JupiterService } from "./JupiterService";
import { Database } from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { Trade, TradeSignal } from "../types/trade";

export class TradeExecutionService {
  private readonly WRAPPED_SOL = "So11111111111111111111111111111111111111112";
  private readonly MAX_RETRIES = 3;
  private readonly MAX_POSITION_SIZE_PERCENT = 0.02; // 2% of portfolio per trade
  private readonly DEFAULT_SLIPPAGE_BPS = 500; // 5% slippage tolerance
  private readonly LAMPORTS_PER_SOL = 1_000_000_000;

  constructor(
    private jupiterService: JupiterService,
    private walletClient: WalletClientBase,
    private db: Database
  ) {}

  async executeTrade(signal: TradeSignal): Promise<boolean> {
    try {
      console.log(`🚀 Executing trade for token ${signal.tokenAddress}`);

      // 1. Get wallet balance in lamports
      const walletAddress = this.walletClient.getAddress();
      const balance = await this.walletClient.balanceOf(walletAddress);
      const lamportsBalance = BigInt(balance.value);
      const solBalance = Number(lamportsBalance) / this.LAMPORTS_PER_SOL;

      console.log("Wallet balance:", {
        lamportsBalance: lamportsBalance.toString(),
        solBalance: solBalance.toFixed(9),
      });

      // 2. Calculate position size with debug logging
      const maxPositionLamports =
        (lamportsBalance * BigInt(this.MAX_POSITION_SIZE_PERCENT * 100)) /
        BigInt(100);
      console.log("Max position (1% of balance):", {
        inLamports: maxPositionLamports.toString(),
        inSol: Number(maxPositionLamports) / this.LAMPORTS_PER_SOL,
      });

      const confidenceAdjusted =
        (maxPositionLamports * BigInt(signal.confidence)) / BigInt(100);
      console.log("After confidence adjustment:", {
        confidence: signal.confidence,
        inLamports: confidenceAdjusted.toString(),
        inSol: Number(confidenceAdjusted) / this.LAMPORTS_PER_SOL,
      });

      const feesAdjusted = (confidenceAdjusted * BigInt(995)) / BigInt(1000);
      console.log("After fees adjustment:", {
        inLamports: feesAdjusted.toString(),
        inSol: Number(feesAdjusted) / this.LAMPORTS_PER_SOL,
      });

      // Safety check - ensure we have enough SOL (including buffer for fees)
      const minSolForFees = BigInt(10000000); // 0.01 SOL for fees
      if (feesAdjusted + minSolForFees >= lamportsBalance) {
        console.error("❌ Position size plus fees exceeds available balance");
        return false;
      }

      // Additional safety check - maximum trade size
      const maxTradeSize = BigInt(lamportsBalance) / BigInt(2); // Never use more than 50% of balance
      if (feesAdjusted > maxTradeSize) {
        console.error("❌ Trade size exceeds maximum allowed");
        return false;
      }

      // 3. Get quote from Jupiter
      console.log(`Getting quote from Jupiter...`);
      const quote = await this.jupiterService.getQuote({
        inputMint: this.WRAPPED_SOL,
        outputMint: signal.tokenAddress,
        amount: Number(feesAdjusted),
        slippageBps: this.DEFAULT_SLIPPAGE_BPS,
      });

      if (!quote) {
        console.error("❌ Failed to get quote from Jupiter");
        return false;
      }

      console.log("Quote details:", {
        inputAmount: quote.inAmount,
        outputAmount: quote.outAmount,
        priceImpact: quote.priceImpactPct,
      });

      // 4. Create trade record
      const tradeSizeInSol = Number(feesAdjusted) / this.LAMPORTS_PER_SOL;
      const trade = await this.createTrade(
        signal,
        tradeSizeInSol,
        quote.outAmount
      );

      // 5. Execute swap
      console.log(`Executing swap...`);
      const swapResult = await this.jupiterService.executeSwap(
        quote,
        // @ts-ignore
        this.walletClient
      );

      if (!swapResult) {
        await this.updateTradeStatus(trade.id, "FAILED");
        console.error("❌ Swap execution failed");
        return false;
      }

      // 6. Update trade status
      await this.updateTradeStatus(trade.id, "EXECUTED", {
        txId: swapResult.txid,
      });

      console.log(`✅ Trade executed successfully! TxID: ${swapResult.txid}`);
      return true;
    } catch (error) {
      console.error("Error executing trade:", error);
      return false;
    }
  }

  private calculatePositionSizeInLamports(
    balanceInLamports: bigint,
    confidence: number
  ): bigint {
    // Calculate max position (2% of portfolio)
    const maxPositionLamports =
      (balanceInLamports * BigInt(this.MAX_POSITION_SIZE_PERCENT * 100)) /
      BigInt(100);

    // Apply confidence adjustment
    const confidenceAdjusted =
      (maxPositionLamports * BigInt(confidence)) / BigInt(100);

    // Leave room for fees (0.5%)
    const adjustedForFees = (confidenceAdjusted * BigInt(995)) / BigInt(1000);

    return adjustedForFees;
  }

  private async createTrade(
    signal: { id: string; tokenAddress: string; price?: number },
    positionSize: number,
    outputAmount: number
  ): Promise<Trade> {
    const trade: Trade = {
      id: uuidv4(),
      tokenAddress: signal.tokenAddress,
      signalId: signal.id,
      entryPrice: signal.price || 0,
      positionSize: positionSize,
      stopLossPrice: signal.price ? signal.price * 0.85 : 0,
      status: "PENDING",
    };

    this.db
      .prepare(
        `
        INSERT INTO trades (
          id,
          token_address,
          signal_id,
          entry_price,
          position_size,
          status,
          entry_time
        ) VALUES (?, ?, ?, ?, ?, ?, unixepoch())
      `
      )
      .run(
        trade.id,
        trade.tokenAddress,
        trade.signalId,
        trade.entryPrice,
        trade.positionSize,
        trade.status
      );

    return trade;
  }

  private async updateTradeStatus(
    tradeId: string,
    status: Trade["status"],
    extra: { txId?: string } = {}
  ) {
    this.db
      .prepare(
        `
        UPDATE trades
        SET status = ?,
            tx_id = ?
        WHERE id = ?
      `
      )
      .run(status, extra.txId || null, tradeId);
  }
}

export const createTradeExecutionService = (
  jupiterService: JupiterService,
  walletClient: any,
  db: Database
) => {
  return new TradeExecutionService(jupiterService, walletClient, db);
};
