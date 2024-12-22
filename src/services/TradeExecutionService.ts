// src/services/trade-execution.ts
import { WalletClientBase } from "@goat-sdk/core";
import { JupiterService } from "./JupiterService";
import { Database } from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";

interface Trade {
  id: string;
  tokenAddress: string;
  signalId: string;
  entryPrice: number;
  positionSize: number;
  stopLossPrice: number;
  status: "PENDING" | "EXECUTED" | "FAILED" | "CLOSED";
}

export interface TradeSignal {
  id: string;
  tokenAddress: string;
  type: "BUY" | "SELL";
  price?: number;
  confidence: number;
}

export class TradeExecutionService {
  private readonly WRAPPED_SOL = "So11111111111111111111111111111111111111112";
  private readonly MAX_RETRIES = 3;
  private readonly MAX_POSITION_SIZE_PERCENT = 0.02; // 2% of portfolio per trade
  private readonly DEFAULT_SLIPPAGE_BPS = 500; // 5% slippage tolerance

  constructor(
    private jupiterService: JupiterService,
    private walletClient: WalletClientBase, // GOAT wallet client
    private db: Database
  ) {}

  async executeTrade(signal: TradeSignal): Promise<boolean> {
    try {
      console.log(`🚀 Executing trade for token ${signal.tokenAddress}`);

      // 1. Get wallet balance
      const walletAddress = this.walletClient.getAddress();
      const balance = await this.walletClient.balanceOf(walletAddress);
      const solBalance = Number(balance.value) / 1e9; // Convert to SOL
      console.log(`Current wallet balance: ${solBalance} SOL`);

      // 2. Calculate position size
      const positionSize = await this.calculatePositionSize(signal, solBalance);
      console.log(`Calculated position size: ${positionSize} SOL`);

      // 3. Get quote from Jupiter
      console.log(`Getting quote from Jupiter...`);
      const quote = await this.jupiterService.getQuote({
        inputMint: this.WRAPPED_SOL,
        outputMint: signal.tokenAddress,
        amount: positionSize * 1e9, // Convert to lamports
        slippageBps: this.DEFAULT_SLIPPAGE_BPS,
      });

      if (!quote) {
        console.error("❌ Failed to get quote from Jupiter");
        return false;
      }

      // 4. Execute swap
      const trade = await this.createTrade(
        signal,
        positionSize,
        quote.outAmount
      );

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

      // 5. Update trade status
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

  private async calculatePositionSize(
    signal: { confidence: number },
    walletBalance: number
  ): Promise<number> {
    // Simple position sizing: 2% of portfolio * confidence adjustment
    const maxPosition = walletBalance * this.MAX_POSITION_SIZE_PERCENT;
    const confidenceAdjusted = maxPosition * (signal.confidence / 100);
    return confidenceAdjusted;
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
      stopLossPrice: signal.price ? signal.price * 0.85 : 0, // 15% stop loss
      status: "PENDING",
    };

    // Store in database
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
