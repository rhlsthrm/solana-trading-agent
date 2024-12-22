// src/processors/SignalTradeProcessor.ts
import { JupiterService } from "../services/jupiter";
import Database from "better-sqlite3";
import { PublicKey } from "@solana/web3.js";

export interface Signal {
  id: string;
  tokenAddress: string;
  type: "BUY" | "SELL";
  price: number;
  riskLevel?: "LOW" | "MEDIUM" | "HIGH";
  timeframe?: string;
}

interface TradeConfig {
  minLiquidity: number;
  minVolume24h: number;
  maxPositionSizePercent: number;
  stopLossPercent: number;
  maxSlippagePercent: number;
  maxDrawdownPercent: number;
}

interface ValidationResult {
  isValid: boolean;
  reason?: string;
  tokenInfo?: {
    price: number;
    liquidity: number;
    volume24h: number;
  };
}

interface TradeResult {
  success: boolean;
  txId?: string;
  error?: string;
  entryPrice?: number;
  positionSize?: number;
}

export class SignalTradeProcessor {
  constructor(
    private jupiterService: JupiterService,
    private db: Database.Database,
    private config: TradeConfig,
    private walletClient: any // GOAT wallet client
  ) {}

  isSolanaAddress(address: string): boolean {
    try {
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }

  async validateSignal(signal: Signal): Promise<ValidationResult> {
    try {
      console.log(`Validating signal for token: ${signal.tokenAddress}`);

      // Check if it's a valid Solana address first
      if (!this.isSolanaAddress(signal.tokenAddress)) {
        return {
          isValid: false,
          reason: "Not a valid Solana token address",
        };
      }

      // Get token info from Jupiter
      const tokenInfo = await this.jupiterService.getTokenInfo(
        signal.tokenAddress
      );
      if (!tokenInfo) {
        return {
          isValid: false,
          reason: "Token not found on Jupiter",
        };
      }

      // Check if token meets minimum requirements
      if (tokenInfo.liquidity < this.config.minLiquidity) {
        return {
          isValid: false,
          reason: `Insufficient liquidity: ${tokenInfo.liquidity} < ${this.config.minLiquidity}`,
          tokenInfo: {
            price: tokenInfo.price || 0,
            liquidity: tokenInfo.liquidity,
            volume24h: tokenInfo.volume24h,
          },
        };
      }

      if (tokenInfo.volume24h < this.config.minVolume24h) {
        return {
          isValid: false,
          reason: `Insufficient 24h volume: ${tokenInfo.volume24h} < ${this.config.minVolume24h}`,
          tokenInfo: {
            price: tokenInfo.price || 0,
            liquidity: tokenInfo.liquidity,
            volume24h: tokenInfo.volume24h,
          },
        };
      }

      // Check if we can get a valid price
      const currentPrice = await this.jupiterService.getTokenPrice(
        signal.tokenAddress
      );
      if (!currentPrice) {
        return {
          isValid: false,
          reason: "Could not get current token price",
          tokenInfo: {
            price: 0,
            liquidity: tokenInfo.liquidity,
            volume24h: tokenInfo.volume24h,
          },
        };
      }

      // If signal has a price, check if it's too far from current price
      if (signal.price && signal.price > 0) {
        const priceDiff =
          (Math.abs(currentPrice - signal.price) / signal.price) * 100;
        if (priceDiff > this.config.maxSlippagePercent) {
          return {
            isValid: false,
            reason: `Current price differs too much from signal price: ${priceDiff.toFixed(
              2
            )}% > ${this.config.maxSlippagePercent}%`,
            tokenInfo: {
              price: currentPrice,
              liquidity: tokenInfo.liquidity,
              volume24h: tokenInfo.volume24h,
            },
          };
        }
      }

      // Store token info in database if not exists
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO tokens (
          address,
          symbol,
          liquidity,
          volume_24h,
          last_updated
        ) VALUES (?, ?, ?, ?, datetime('now'))
      `);

      stmt.run(
        signal.tokenAddress,
        tokenInfo.symbol,
        tokenInfo.liquidity,
        tokenInfo.volume24h
      );

      return {
        isValid: true,
        tokenInfo: {
          price: currentPrice,
          liquidity: tokenInfo.liquidity,
          volume24h: tokenInfo.volume24h,
        },
      };
    } catch (error) {
      console.error("Error validating signal:", error);
      return {
        isValid: false,
        reason: `Validation error: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      };
    }
  }

  async calculatePositionSize(
    tokenAddress: string,
    tokenPrice: number,
    riskLevel: "LOW" | "MEDIUM" | "HIGH" = "MEDIUM"
  ): Promise<number> {
    try {
      // Get wallet SOL balance
      const walletAddress = this.walletClient.getAddress();
      const balance = await this.walletClient.balanceOf(walletAddress);
      const solBalance = Number(balance.toString()) / 1e9; // Convert lamports to SOL

      // Get SOL price
      const solPrice = await this.jupiterService.getTokenPrice(
        "So11111111111111111111111111111111111111112" // Native SOL mint address
      );
      if (!solPrice) throw new Error("Could not get SOL price");

      // Calculate portfolio value in USD
      const portfolioValueUSD = solBalance * solPrice;

      // Adjust position size based on risk level
      const riskMultiplier = {
        LOW: 0.5,
        MEDIUM: 1.0,
        HIGH: 1.5,
      }[riskLevel];

      // Calculate maximum position size
      const maxPositionUSD =
        portfolioValueUSD *
        (this.config.maxPositionSizePercent / 100) *
        riskMultiplier;

      // Check liquidity depth to ensure we can execute the trade
      const { canFill, expectedSlippage } =
        await this.jupiterService.getLiquidityDepth(
          tokenAddress,
          maxPositionUSD
        );

      if (!canFill || expectedSlippage > this.config.maxSlippagePercent) {
        // If we can't fill at max size, try half size
        const halfSize = maxPositionUSD / 2;
        const halfSizeCheck = await this.jupiterService.getLiquidityDepth(
          tokenAddress,
          halfSize
        );

        if (
          !halfSizeCheck.canFill ||
          halfSizeCheck.expectedSlippage > this.config.maxSlippagePercent
        ) {
          throw new Error("Insufficient liquidity for position size");
        }

        return halfSize;
      }

      return maxPositionUSD;
    } catch (error) {
      console.error("Error calculating position size:", error);
      throw error;
    }
  }

  async executeTrade(
    signal: Signal,
    positionSizeUSD: number
  ): Promise<TradeResult> {
    try {
      // Get quote from Jupiter
      const quote = await this.jupiterService.getQuote({
        inputMint: "So11111111111111111111111111111111111111112", // Native SOL
        outputMint: signal.tokenAddress,
        amount: positionSizeUSD,
        slippageBps: this.config.maxSlippagePercent * 100, // Convert percent to basis points
      });

      if (!quote) {
        throw new Error("Could not get quote from Jupiter");
      }

      // Execute swap
      const swapResult = await this.jupiterService.executeSwap(
        quote,
        this.walletClient
      );
      if (!swapResult) {
        throw new Error("Swap execution failed");
      }

      // Log trade in database
      const stmt = this.db.prepare(`
        INSERT INTO trades (
          id,
          token_address,
          entry_price,
          position_size,
          signal_id,
          entry_time,
          status
        ) VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
      `);

      stmt.run(
        swapResult.txid,
        signal.tokenAddress,
        quote.inAmount / quote.outAmount, // Calculate entry price
        positionSizeUSD,
        signal.id,
        "OPEN"
      );

      // Mark signal as processed
      const updateSignal = this.db.prepare(`
        UPDATE signals 
        SET processed = true 
        WHERE id = ?
      `);

      updateSignal.run(signal.id);

      return {
        success: true,
        txId: swapResult.txid,
        entryPrice: quote.inAmount / quote.outAmount,
        positionSize: positionSizeUSD,
      };
    } catch (error) {
      console.error("Error executing trade:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
}
