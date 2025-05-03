// src/services/position-manager.ts
import Database from "better-sqlite3";
import { JupiterService } from "./JupiterService";
import { SolanaWalletClient } from "../types/trade";

export interface Position {
  id: string;
  tokenAddress: string;
  amount: number;
  entryPrice: number;
  currentPrice: number | null;
  lastUpdated: number;
  profitLoss: number | null;
  status: "ACTIVE" | "CLOSED" | "LIQUIDATED";
}

export interface PositionMetrics {
  totalValue: number;
  profitLoss: number;
  profitLossPercentage: number;
}

export class PositionManager {
  constructor(
    private db: Database.Database,
    private jupiterService: JupiterService,
    private walletClient: SolanaWalletClient
  ) {
    this.initializeDatabase();
  }

  private initializeDatabase() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS positions (
        id TEXT PRIMARY KEY,
        token_address TEXT NOT NULL,
        amount NUMERIC NOT NULL,
        entry_price NUMERIC NOT NULL,
        current_price NUMERIC,
        last_updated INTEGER NOT NULL,
        profit_loss NUMERIC,
        status TEXT CHECK (status IN ('ACTIVE', 'CLOSED', 'LIQUIDATED'))
      );

      CREATE INDEX IF NOT EXISTS idx_positions_token_address 
        ON positions(token_address);
      
      CREATE INDEX IF NOT EXISTS idx_positions_status 
        ON positions(status);
    `);
  }

  async createPosition(params: {
    tokenAddress: string;
    amount: number;
    entryPrice: number;
  }): Promise<Position> {
    console.log(`Creating position for ${params.tokenAddress} with amount ${params.amount} and entry price ${params.entryPrice}`);
    
    // Save the exact amount from the blockchain/Jupiter
    // No need to manipulate it as we'll handle conversion in the UI
    const position: Position = {
      id: Math.random().toString(36).substring(7),
      tokenAddress: params.tokenAddress,
      amount: params.amount,
      entryPrice: params.entryPrice,
      currentPrice: params.entryPrice,
      lastUpdated: Date.now(),
      profitLoss: 0,
      status: "ACTIVE",
    };

    this.db
      .prepare(
        `
      INSERT INTO positions (
        id,
        token_address,
        amount,
        entry_price,
        current_price,
        last_updated,
        profit_loss,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        position.id,
        position.tokenAddress,
        position.amount,
        position.entryPrice,
        position.currentPrice,
        position.lastUpdated,
        position.profitLoss,
        position.status
      );

    return position;
  }

  async getPosition(id: string): Promise<Position | null> {
    const position = this.db
      .prepare(
        `
      SELECT 
        id,
        token_address as tokenAddress,
        amount,
        entry_price as entryPrice,
        current_price as currentPrice,
        last_updated as lastUpdated,
        profit_loss as profitLoss,
        status
      FROM positions 
      WHERE id = ?
    `
      )
      .get(id);

    return (position as Position) || null;
  }

  async getPositionByToken(tokenAddress: string): Promise<Position | null> {
    const position = this.db
      .prepare(
        `
      SELECT 
        id,
        token_address as tokenAddress,
        amount,
        entry_price as entryPrice,
        current_price as currentPrice,
        last_updated as lastUpdated,
        profit_loss as profitLoss,
        status
      FROM positions 
      WHERE token_address = ? 
      AND status = 'ACTIVE'
    `
      )
      .get(tokenAddress);

    return (position as Position) || null;
  }

  async getAllActivePositions(): Promise<Position[]> {
    const positions = this.db
      .prepare(
        `
      SELECT 
        id,
        token_address as tokenAddress,
        amount,
        entry_price as entryPrice,
        current_price as currentPrice,
        last_updated as lastUpdated,
        profit_loss as profitLoss,
        status
      FROM positions 
      WHERE status = 'ACTIVE'
    `
      )
      .all();

    return positions as Position[];
  }

  async updatePosition(
    id: string,
    updates: Partial<Omit<Position, "id">>
  ): Promise<Position | null> {
    const position = await this.getPosition(id);
    if (!position) return null;

    const updatedPosition = { ...position, ...updates };

    const stmt = this.db.prepare(`
      UPDATE positions 
      SET 
        amount = ?,
        current_price = ?,
        last_updated = ?,
        profit_loss = ?,
        status = ?
      WHERE id = ?
    `);

    stmt.run(
      updatedPosition.amount,
      updatedPosition.currentPrice,
      Date.now(),
      updatedPosition.profitLoss,
      updatedPosition.status,
      id
    );

    return updatedPosition;
  }

  async closePosition(id: string): Promise<boolean> {
    try {
      // Start a database transaction
      this.db.exec("BEGIN TRANSACTION");

      try {
        // Get the position
        const position = await this.getPosition(id);
        if (!position) {
          this.db.exec("ROLLBACK");
          return false;
        }

        // Get current token info
        const tokenInfo = await this.jupiterService.getTokenInfo(position.tokenAddress);
        if (!tokenInfo?.isValid || tokenInfo.price === null) {
          console.error(`Failed to get valid token info for ${position.tokenAddress}`);
          this.db.exec("ROLLBACK");
          return false;
        }

        // Get quote for selling tokens back to SOL
        const WRAPPED_SOL = "So11111111111111111111111111111111111111112";
        const quote = await this.jupiterService.getQuote({
          inputMint: position.tokenAddress,
          outputMint: WRAPPED_SOL,
          amount: position.amount,
        });

        if (!quote) {
          console.error(`Failed to get quote for selling ${position.tokenAddress}`);
          this.db.exec("ROLLBACK");
          return false;
        }

        // Execute swap (sell tokens back to SOL)
        const result = await this.jupiterService.executeSwap(quote, this.walletClient);
        if (!result) {
          console.error(`Failed to execute swap for ${position.tokenAddress}`);
          this.db.exec("ROLLBACK");
          return false;
        }

        // Calculate final profit/loss
        const finalValue = Number(result.outputAmount);
        const entryValue = position.amount * position.entryPrice;
        const profitLoss = finalValue - entryValue;

        // Record the transaction in the trades table
        this.db
          .prepare(
            `
            INSERT INTO trades (
              id,
              token_address,
              position_size,
              entry_price,
              exit_price,
              exit_time,
              status,
              profit_loss,
              tx_id
            ) VALUES (?, ?, ?, ?, ?, unixepoch(), ?, ?, ?)
          `
          )
          .run(
            crypto.randomUUID(),
            position.tokenAddress,
            position.amount,
            position.entryPrice,
            tokenInfo.price,
            "CLOSED",
            profitLoss,
            result.txid
          );

        // Update position status
        await this.updatePosition(id, {
          status: "CLOSED",
          lastUpdated: Date.now(),
          profitLoss: profitLoss,
          currentPrice: tokenInfo.price,
        });

        // Commit the transaction
        this.db.exec("COMMIT");
        console.log(`✅ Position ${id} closed successfully. Final P&L: ${profitLoss}`);
        return true;
      } catch (error) {
        // Rollback on error
        this.db.exec("ROLLBACK");
        console.error(`Error closing position ${id}:`, error);
        return false;
      }
    } catch (error) {
      console.error(`Error in closePosition for ${id}:`, error);
      return false;
    }
  }

  async updatePricesAndProfitLoss(): Promise<void> {
    const activePositions = await this.getAllActivePositions();

    for (const position of activePositions) {
      try {
        // Get the latest price directly from the price API
        const currentPrice = await this.jupiterService.getCurrentPrice(position.tokenAddress);
        
        if (currentPrice === null) {
          console.warn(`⚠️ Could not get current price for ${position.tokenAddress}, skipping update`);
          continue;
        }
        
        // Try to get the full token info for additional data
        let tokenInfo = null;
        try {
          tokenInfo = await this.jupiterService.getTokenInfo(position.tokenAddress);
        } catch (error) {
          console.warn(`Error getting token info for ${position.tokenAddress}, using defaults`);
        }
        
        // Get the number of decimal places for this token (default to 6)
        const tokenDecimals = (tokenInfo && tokenInfo.decimals) ? tokenInfo.decimals : 6;
        
        // Calculate profit/loss using the amount without decimal normalization
        const currentValue = position.amount * currentPrice;
        const entryValue = position.amount * position.entryPrice;
        const profitLoss = currentValue - entryValue;
        
        // Calculate percentage based on entry value to avoid division by zero
        const profitLossPercentage = entryValue > 0 ? (profitLoss / entryValue) * 100 : 0;

        console.log(`Position update for ${position.tokenAddress}:`, {
          amount: position.amount,
          entryPrice: position.entryPrice,
          currentPrice: currentPrice,
          entryValue,
          currentValue,
          profitLoss,
          profitLossPercentage: `${profitLossPercentage.toFixed(2)}%`
        });

        // Log price change
        const priceChanged = position.currentPrice !== currentPrice;
        if (priceChanged) {
          console.log(`🔄 Price updated for ${position.tokenAddress} from $${position.currentPrice} to $${currentPrice}`);
        } else {
          console.log(`ℹ️ Price unchanged for ${position.tokenAddress}: $${currentPrice}`);
        }
        
        // Update position
        await this.updatePosition(position.id, {
          currentPrice: currentPrice,
          profitLoss,
          lastUpdated: Date.now(),
        });

        // Check for stop loss (example: -15%)
        if (profitLossPercentage < -15) {
          console.log(`⚠️ Stop loss triggered for position ${position.id} (${profitLossPercentage.toFixed(2)}%)`);
          
          // Execute stop loss by closing the position
          const success = await this.closePosition(position.id);
          if (success) {
            console.log(`✅ Stop loss executed for position ${position.id} at ${profitLossPercentage.toFixed(2)}%`);
          } else {
            console.error(`❌ Failed to execute stop loss for position ${position.id}`);
          }
        }

        // Check for take profit (example: +30%)
        if (profitLossPercentage > 30) {
          console.log(`🎯 Take profit triggered for position ${position.id} (${profitLossPercentage.toFixed(2)}%)`);
          
          // Execute take profit by closing the position
          const success = await this.closePosition(position.id);
          if (success) {
            console.log(`✅ Take profit executed for position ${position.id} at ${profitLossPercentage.toFixed(2)}%`);
          } else {
            console.error(`❌ Failed to execute take profit for position ${position.id}`);
          }
        }
      } catch (error) {
        console.error(`Error updating position ${position.id}:`, error);
      }
    }
  }

  async closePositionByToken(tokenAddress: string): Promise<boolean> {
    try {
      const position = await this.getPositionByToken(tokenAddress);
      if (!position) {
        console.log(`No active position found for token ${tokenAddress}`);
        return false;
      }
      
      return await this.closePosition(position.id);
    } catch (error) {
      console.error(`Error closing position for token ${tokenAddress}:`, error);
      return false;
    }
  }

  async getPortfolioMetrics(): Promise<PositionMetrics> {
    const positions = await this.getAllActivePositions();
    let totalValue = 0;
    let totalProfitLoss = 0;

    for (const position of positions) {
      if (position.currentPrice !== null) {
        // Calculate using the amount as is - since we're storing raw amounts
        const value = position.amount * position.currentPrice;
        totalValue += value;
        totalProfitLoss += position.profitLoss || 0;
      }
    }

    // Apply scaling in dashboard display but keep raw calculations here
    console.log("Portfolio metrics:", {
      totalValue,
      totalProfitLoss,
      positions: positions.length
    });

    const profitLossPercentage =
      totalValue > 0 ? (totalProfitLoss / totalValue) * 100 : 0;

    return {
      totalValue,
      profitLoss: totalProfitLoss,
      profitLossPercentage,
    };
  }
}

export const createPositionManager = (
  db: Database.Database,
  jupiterService: JupiterService,
  walletClient: SolanaWalletClient
) => {
  return new PositionManager(db, jupiterService, walletClient);
};
