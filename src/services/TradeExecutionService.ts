// src/services/trade-execution.ts
import { JupiterService } from "./JupiterService";
import { Database } from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { SolanaWalletClient, Trade, TradeSignal } from "../types/trade";
import { PositionManager } from "./PositionManager";

export class TradeExecutionService {
  private readonly WRAPPED_SOL = "So11111111111111111111111111111111111111112";
  private readonly MAX_POSITION_SIZE_PERCENT = 0.02; // 2% of portfolio per trade
  private readonly DEFAULT_SLIPPAGE_BPS = 500; // 5% slippage tolerance
  private readonly LAMPORTS_PER_SOL = 1_000_000_000;
  private readonly MIN_CONFIDENCE_SCORE = 65;

  constructor(
    private jupiterService: JupiterService,
    private walletClient: SolanaWalletClient,
    private db: Database,
    private positionManager: PositionManager
  ) {}

  async executeTrade(signal: TradeSignal): Promise<boolean> {
    try {
      // Check minimum confidence score
      if (signal.confidence < this.MIN_CONFIDENCE_SCORE) {
        console.log(
          `❌ Signal confidence ${signal.confidence} below minimum threshold ${this.MIN_CONFIDENCE_SCORE}`
        );
        return false;
      }

      // Check for existing position
      const existingPosition = await this.positionManager.getPositionByToken(
        signal.tokenAddress
      );
      if (existingPosition) {
        console.log(`⚠️ Already have position in ${signal.tokenAddress}`);
        return false;
      }

      console.log(`🚀 Executing trade for token ${signal.tokenAddress}`);

      // Get wallet balance
      const walletAddress = this.walletClient.getAddress();
      const balance = await this.walletClient.balanceOf(walletAddress);
      const lamportsBalance = BigInt(balance.value);
      const solBalance = Number(lamportsBalance) / this.LAMPORTS_PER_SOL;

      // Calculate position size based on confidence
      const positionSize = this.calculatePositionSize(
        lamportsBalance,
        signal.confidence
      );

      if (!this.validatePositionSize(positionSize, lamportsBalance)) {
        return false;
      }

      // Get quote from Jupiter
      const quote = await this.jupiterService.getQuote({
        inputMint: this.WRAPPED_SOL,
        outputMint: signal.tokenAddress,
        amount: Number(positionSize),
        slippageBps: this.DEFAULT_SLIPPAGE_BPS,
      });

      if (!quote) {
        console.error("❌ Failed to get quote from Jupiter");
        return false;
      }

      // Create trade record
      const tradeSizeInSol = Number(positionSize) / this.LAMPORTS_PER_SOL;
      const trade = await this.createTrade(
        signal,
        tradeSizeInSol,
        quote.outAmount
      );

      // Execute swap
      console.log(`Executing swap...`);
      const swapResult = await this.jupiterService.executeSwap(
        quote,
        this.walletClient
      );

      if (!swapResult) {
        await this.updateTradeStatus(trade.id, "FAILED");
        console.error("❌ Swap execution failed");
        return false;
      }

      // Create position record
      const tokenInfo = await this.jupiterService.getTokenInfo(
        signal.tokenAddress
      );
      if (!tokenInfo) {
        console.error("❌ Failed to get token info");
        return false;
      }

      await this.positionManager.createPosition({
        tokenAddress: signal.tokenAddress,
        amount: quote.outAmount,
        entryPrice: tokenInfo.price || 0,
      });

      // Update trade status
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

  private calculatePositionSize(
    balanceLamports: bigint,
    confidence: number
  ): bigint {
    // Base position size (2% of portfolio)
    const baseSize =
      (balanceLamports * BigInt(this.MAX_POSITION_SIZE_PERCENT * 100)) /
      BigInt(100);

    // Adjust based on confidence (50-100% of base size)
    const confidenceAdjustment = Math.max(50, confidence) / 100;
    const adjustedSize =
      (baseSize * BigInt(Math.floor(confidenceAdjustment * 100))) / BigInt(100);

    // Reserve for fees (0.5%)
    return (adjustedSize * BigInt(995)) / BigInt(1000);
  }

  private validatePositionSize(
    positionSize: bigint,
    balanceLamports: bigint
  ): boolean {
    const minSolForFees = BigInt(10000000); // 0.01 SOL for fees

    if (positionSize + minSolForFees >= balanceLamports) {
      console.error("❌ Position size plus fees exceeds available balance");
      return false;
    }

    const maxTradeSize = balanceLamports / BigInt(2); // Max 50% of balance
    if (positionSize > maxTradeSize) {
      console.error("❌ Trade size exceeds maximum allowed");
      return false;
    }

    return true;
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
  walletClient: SolanaWalletClient,
  db: Database,
  positionManager: PositionManager
) => {
  return new TradeExecutionService(
    jupiterService,
    walletClient,
    db,
    positionManager
  );
};
