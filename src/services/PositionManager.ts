// src/services/position-manager.ts
import Database from "better-sqlite3";
import { JupiterService } from "./JupiterService";
import { SolanaWalletClient } from "../types/trade";
import { randomUUID } from "../utils/uuid";
import { tradingSchema } from "../utils/db-schema";
import { runMigrations } from "../utils/migrations";

export interface Position {
  id: string;
  tokenAddress: string;
  amount: number;
  entryPrice: number;
  currentPrice: number | null;
  highestPrice: number | null;
  lastUpdated: number;
  profitLoss: number | null;
  status: "ACTIVE" | "CLOSED" | "LIQUIDATED";
  trailingStopPercentage: number;
}

export interface PositionMetrics {
  totalValue: number;
  profitLoss: number;
  profitLossPercentage: number;
}

export interface ProfitLossData {
  activePnL: number;
  closedPositionsPnL: number;
  tradePnL: number;
  totalPnL: number;
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
    try {
      // First ensure the base schema exists
      this.db.exec(tradingSchema);
      
      // Then run migrations to add any missing columns and update existing data
      runMigrations(this.db);
    } catch (error) {
      console.error("Error initializing database:", error);
      throw error;
    }
  }

  async createPosition(params: {
    tokenAddress: string;
    amount: number;
    entryPrice: number;
    trailingStopPercentage?: number;
  }): Promise<Position> {
    console.log(
      `Creating position for ${params.tokenAddress} with amount ${params.amount} and entry price ${params.entryPrice}`
    );

    // Save the exact amount from the blockchain/Jupiter
    // No need to manipulate it as we'll handle conversion in the UI
    const position: Position = {
      id: randomUUID(),
      tokenAddress: params.tokenAddress,
      amount: params.amount,
      entryPrice: params.entryPrice,
      currentPrice: params.entryPrice,
      highestPrice: params.entryPrice,
      lastUpdated: Date.now(),
      profitLoss: 0,
      status: "ACTIVE",
      trailingStopPercentage: params.trailingStopPercentage || 20,
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
        highest_price,
        last_updated,
        profit_loss,
        status,
        trailing_stop_percentage
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        position.id,
        position.tokenAddress,
        position.amount,
        position.entryPrice,
        position.currentPrice,
        position.highestPrice,
        position.lastUpdated,
        position.profitLoss,
        position.status,
        position.trailingStopPercentage
      );

    return position;
  }

  // Prepared statement for getting a position by ID
  // Use lazy initialization for prepared statements to ensure migrations run first
  private get getPositionStmt() {
    return this.db.prepare(`
      SELECT 
        id,
        token_address as tokenAddress,
        amount,
        entry_price as entryPrice,
        current_price as currentPrice,
        COALESCE(highest_price, current_price, entry_price) as highestPrice,
        last_updated as lastUpdated,
        profit_loss as profitLoss,
        status,
        COALESCE(trailing_stop_percentage, 20) as trailingStopPercentage
      FROM positions 
      WHERE id = ?
    `);
  }

  async getPosition(id: string): Promise<Position | null> {
    const position = this.getPositionStmt.get(id);
    return (position as Position) || null;
  }

  // Prepared statement for getting a position by token address
  private get getPositionByTokenStmt() {
    return this.db.prepare(`
      SELECT 
        id,
        token_address as tokenAddress,
        amount,
        entry_price as entryPrice,
        current_price as currentPrice,
        COALESCE(highest_price, current_price, entry_price) as highestPrice,
        last_updated as lastUpdated,
        profit_loss as profitLoss,
        status,
        COALESCE(trailing_stop_percentage, 20) as trailingStopPercentage
      FROM positions 
      WHERE token_address = ? 
      AND status = 'ACTIVE'
    `);
  }

  async getPositionByToken(tokenAddress: string): Promise<Position | null> {
    const position = this.getPositionByTokenStmt.get(tokenAddress);
    return (position as Position) || null;
  }

  // Prepared statement for getting all active positions
  private get getAllActivePositionsStmt() {
    return this.db.prepare(`
      SELECT 
        id,
        token_address as tokenAddress,
        amount,
        entry_price as entryPrice,
        current_price as currentPrice,
        COALESCE(highest_price, current_price, entry_price) as highestPrice,
        last_updated as lastUpdated,
        profit_loss as profitLoss,
        status,
        COALESCE(trailing_stop_percentage, 20) as trailingStopPercentage
      FROM positions 
      WHERE status = 'ACTIVE'
    `);
  }

  async getAllActivePositions(): Promise<Position[]> {
    // Execute the prepared statement
    const positions = this.getAllActivePositionsStmt.all();

    return positions as Position[];
  }

  // Prepare statements once during initialization for better performance
  private get updatePositionStmt() {
    return this.db.prepare(`
      UPDATE positions 
      SET 
        amount = ?,
        current_price = ?,
        highest_price = ?,
        last_updated = ?,
        profit_loss = ?,
        status = ?,
        trailing_stop_percentage = ?
      WHERE id = ?
    `);
  }

  async updatePosition(
    id: string,
    updates: Partial<Omit<Position, "id">>
  ): Promise<Position | null> {
    const position = await this.getPosition(id);
    if (!position) return null;

    const updatedPosition = { ...position, ...updates };

    this.updatePositionStmt.run(
      updatedPosition.amount,
      updatedPosition.currentPrice,
      updatedPosition.highestPrice,
      Date.now(),
      updatedPosition.profitLoss,
      updatedPosition.status,
      updatedPosition.trailingStopPercentage,
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
        const tokenInfo = await this.jupiterService.getTokenInfo(
          position.tokenAddress
        );
        if (!tokenInfo?.isValid || tokenInfo.price === null) {
          console.error(
            `Failed to get valid token info for ${position.tokenAddress}`
          );
          this.db.exec("ROLLBACK");
          return false;
        }

        // Get the actual token balance from the blockchain
        const { getTokenBalance } = await import("../utils/token-balance");
        const walletAddress = this.walletClient.getAddress();

        const actualTokenBalance = await getTokenBalance(
          position.tokenAddress,
          walletAddress
        );

        if (actualTokenBalance === null) {
          console.error(
            `Failed to get actual token balance for ${position.tokenAddress}`
          );
          this.db.exec("ROLLBACK");
          return false;
        }

        // If we have zero tokens, we can't sell anything
        if (actualTokenBalance <= 0) {
          this.db.exec("ROLLBACK");
          return false;
        }

        // Update position amount to match actual balance (prevents "insufficient funds" errors)
        position.amount = Number(actualTokenBalance);

        // Get quote for selling tokens back to SOL using the corrected amount
        const WRAPPED_SOL = "So11111111111111111111111111111111111111112";
        const quote = await this.jupiterService.getQuote({
          inputMint: position.tokenAddress,
          outputMint: WRAPPED_SOL,
          amount: position.amount,
        });

        if (!quote) {
          console.error(
            `Failed to get quote for selling ${position.tokenAddress}`
          );
          this.db.exec("ROLLBACK");
          return false;
        }

        // Execute swap (sell tokens back to SOL)
        const result = await this.jupiterService.executeSwap(
          quote,
          this.walletClient
        );
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
            randomUUID(),
            position.tokenAddress,
            position.amount,
            position.entryPrice,
            tokenInfo.price,
            "CLOSED",
            profitLoss,
            result.txid
          );

        const currentTime = Date.now();
        // Update position status
        await this.updatePosition(id, {
          status: "CLOSED",
          lastUpdated: currentTime,
          profitLoss: profitLoss,
          currentPrice: tokenInfo.price,
        });
        
        // Set exit_time directly in positions table
        this.db.prepare(`
          UPDATE positions 
          SET exit_time = ? 
          WHERE id = ?
        `).run(currentTime, id);

        // Commit the transaction
        this.db.exec("COMMIT");
        console.log(
          `✅ Position ${id} closed successfully. Final P&L: ${profitLoss}`
        );
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

    // Categorize positions into high-priority and regular updates
    const highPriorityPositions: Position[] = [];
    const regularPositions: Position[] = [];

    // First pass - categorize positions without making API calls
    for (const position of activePositions) {
      try {
        // Check if position needs urgent attention based on last known values
        if (position.currentPrice && position.entryPrice) {
          const lastKnownProfitLoss = position.profitLoss || 0;
          const entryValue = position.amount * position.entryPrice;
          const profitLossPercentage =
            entryValue > 0 ? (lastKnownProfitLoss / entryValue) * 100 : 0;

          // Positions approaching stop-loss or take-profit thresholds get priority
          const approachingThreshold =
            (profitLossPercentage < -10 && profitLossPercentage > -20) || // Approaching stop-loss
            (profitLossPercentage > 25 && profitLossPercentage < 30); // Approaching take-profit

          if (approachingThreshold) {
            highPriorityPositions.push(position);
          } else {
            regularPositions.push(position);
          }
        } else {
          // If position doesn't have current price, it needs an update
          highPriorityPositions.push(position);
        }
      } catch (error) {
        console.error(`Error categorizing position ${position.id}:`, error);
        // Put in high-priority on error to ensure it gets checked
        highPriorityPositions.push(position);
      }
    }

    // No need to log position counts

    // Process high-priority positions first
    for (const position of highPriorityPositions) {
      await this.updatePositionPrice(position);
    }

    // Then process regular positions
    for (const position of regularPositions) {
      await this.updatePositionPrice(position);
    }
  }

  // Helper method to update a single position
  private async updatePositionPrice(position: Position): Promise<void> {
    try {
      // Get the latest price directly from the price API
      const currentPrice = await this.jupiterService.getCurrentPrice(
        position.tokenAddress
      );

      if (currentPrice === null) {
        console.warn(
          `⚠️ Could not get current price for ${position.tokenAddress}, skipping update`
        );
        return;
      }

      // Try to get the full token info for additional data
      let tokenInfo = null;
      try {
        tokenInfo = await this.jupiterService.getTokenInfo(
          position.tokenAddress
        );
      } catch (error) {
        console.warn(
          `Error getting token info for ${position.tokenAddress}, using defaults`
        );
      }

      // Calculate profit/loss using the amount without decimal normalization
      const currentValue = position.amount * currentPrice;
      const entryValue = position.amount * position.entryPrice;
      const profitLoss = currentValue - entryValue;

      // Calculate percentage based on entry value to avoid division by zero
      const profitLossPercentage =
        entryValue > 0 ? (profitLoss / entryValue) * 100 : 0;

      // Determine if this is a new highest price
      let highestPrice = position.highestPrice || position.entryPrice;
      if (currentPrice > highestPrice) {
        highestPrice = currentPrice;
        console.log(
          `📈 New highest price for ${position.tokenAddress}: ${currentPrice}`
        );
      }

      // Update position with new price info
      await this.updatePosition(position.id, {
        currentPrice: currentPrice,
        highestPrice: highestPrice,
        profitLoss,
        lastUpdated: Date.now(),
      });

      // Check for stop loss (fixed at -20%)
      if (profitLossPercentage < -20) {
        console.log(
          `⚠️ Stop loss triggered for position ${
            position.id
          } (${profitLossPercentage.toFixed(2)}%)`
        );

        // Execute stop loss by closing the position
        const success = await this.closePosition(position.id);
        if (success) {
          console.log(
            `✅ Stop loss executed for position ${
              position.id
            } at ${profitLossPercentage.toFixed(2)}%`
          );
        } else {
          console.error(
            `❌ Failed to execute stop loss for position ${position.id}`
          );
        }
        return; // Exit early after closing the position
      }

      // Check for trailing stop
      if (highestPrice > 0 && currentPrice > 0) {
        // Calculate percentage drop from highest price
        const dropPercentage = ((highestPrice - currentPrice) / highestPrice) * 100;
        
        // Get trailing stop percentage (default to 20% if not set)
        const trailingStopPercentage = position.trailingStopPercentage || 20;
        
        // If price has dropped below trailing stop threshold
        if (dropPercentage >= trailingStopPercentage) {
          console.log(
            `🔻 Trailing stop triggered for position ${position.id} (${dropPercentage.toFixed(2)}% drop from highest price)`
          );
          
          // Execute trailing stop by closing the position
          const success = await this.closePosition(position.id);
          if (success) {
            console.log(
              `✅ Trailing stop executed for position ${position.id}. Highest: ${highestPrice}, Current: ${currentPrice}, Drop: ${dropPercentage.toFixed(2)}%`
            );
          } else {
            console.error(
              `❌ Failed to execute trailing stop for position ${position.id}`
            );
          }
        }
      }
    } catch (error) {
      console.error(`Error updating position ${position.id}:`, error);
    }
  }

  async closePositionByToken(tokenAddress: string): Promise<boolean> {
    try {
      const position = await this.getPositionByToken(tokenAddress);
      if (!position) {
        return false;
      }

      return await this.closePosition(position.id);
    } catch (error) {
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

    const profitLossPercentage =
      totalValue > 0 ? (totalProfitLoss / totalValue) * 100 : 0;

    return {
      totalValue,
      profitLoss: totalProfitLoss,
      profitLossPercentage,
    };
  }
  
  /**
   * Get the total profit/loss from all closed positions
   * Note: This provides a historical record of P&L from the positions table
   */
  async getTotalClosedPositionsPnL(): Promise<number> {
    try {
      // Get all closed positions with details for logging
      const closedPositions = this.db.prepare(`
        SELECT id, token_address, profit_loss, exit_time, amount, entry_price
        FROM positions 
        WHERE status = 'CLOSED'
        ORDER BY exit_time DESC
      `).all() as { 
        id: string; 
        token_address: string; 
        profit_loss: number; 
        exit_time: number;
        amount: number;
        entry_price: number;
      }[];
      
      console.log("\n===== DETAILED CLOSED POSITIONS P&L =====");
      console.log(`Found ${closedPositions.length} closed positions in database`);
      let totalPnLCalculation = 0;
      
      closedPositions.forEach((position, index) => {
        const normalizedPnL = position.profit_loss / 1000000;
        totalPnLCalculation += normalizedPnL;
        const date = position.exit_time ? new Date(position.exit_time).toLocaleString() : 'Unknown';
        const amount = position.amount / 1000000; // Normalize amount for display
        console.log(`Position #${index+1}: ID=${position.id.substring(0,8)}... Token=${position.token_address.substring(0,8)}... Amount=${amount.toFixed(6)} Entry=$${position.entry_price} P&L=$${normalizedPnL.toFixed(6)} Date=${date}`);
      });
      
      // Use a SQL statement that doesn't reference exit_time directly
      // to avoid dependency on this column existing
      const result = this.db.prepare(`
        SELECT SUM(profit_loss) as total_pnl 
        FROM positions 
        WHERE status = 'CLOSED'
      `).get() as { total_pnl: number | null };
      
      const totalPnL = result.total_pnl || 0;
      const normalizedTotalPnL = totalPnL / 1000000;
      
      console.log(`Individual positions sum: $${totalPnLCalculation.toFixed(6)}`);
      console.log(`Database query sum:       $${normalizedTotalPnL.toFixed(6)}`);
      console.log("=========================================\n");
      
      return totalPnL;
    } catch (error) {
      console.error("Error calculating total P&L from closed positions:", error);
      return 0;
    }
  }
  
  /**
   * Get the total profit/loss from all completed trades
   * @param normalized Whether to normalize the P&L by dividing by 1,000,000 (default: true)
   */
  async getTotalTradesPnL(normalized = true): Promise<number> {
    try {
      // First log all trades to see their individual P&L contributions
      const allTrades = this.db.prepare(`
        SELECT id, token_address, profit_loss, exit_time 
        FROM trades 
        WHERE status = 'CLOSED'
        ORDER BY exit_time DESC
      `).all() as { id: string; token_address: string; profit_loss: number; exit_time: number }[];
      
      console.log("\n===== DETAILED TRADE P&L BREAKDOWN =====");
      console.log(`Found ${allTrades.length} closed trades in database`);
      let totalPnLCalculation = 0;
      
      allTrades.forEach((trade, index) => {
        const normalizedPnL = trade.profit_loss / 1000000;
        totalPnLCalculation += normalizedPnL;
        const date = new Date(trade.exit_time * 1000).toLocaleString();
        console.log(`Trade #${index+1}: ID=${trade.id.substring(0,8)}... Token=${trade.token_address.substring(0,8)}... P&L=$${normalizedPnL.toFixed(6)} Date=${date}`);
      });
      
      // Now get the sum as before
      const result = this.db.prepare(`
        SELECT SUM(profit_loss) as total_pnl 
        FROM trades 
        WHERE status = 'CLOSED'
      `).get() as { total_pnl: number | null };
      
      const rawPnL = result.total_pnl || 0;
      const normalizedTotal = normalized ? rawPnL / 1000000 : rawPnL;
      
      console.log(`Individual trades sum: $${totalPnLCalculation.toFixed(6)}`);
      console.log(`Database query sum:   $${(normalizedTotal).toFixed(6)}`);
      console.log("=========================================\n");
      
      return normalizedTotal;
    } catch (error) {
      console.error("Error calculating total P&L from trades:", error);
      return 0;
    }
  }
  
  /**
   * Get comprehensive profit/loss data from all sources
   * This combines active positions, closed positions, and trades
   */
  async getComprehensivePnL(): Promise<ProfitLossData> {
    console.log("\n===== COMPREHENSIVE P&L CALCULATION =====");
    
    // Get portfolio metrics for active positions
    const metrics = await this.getPortfolioMetrics();
    console.log(`Active Positions: ${(await this.getAllActivePositions()).length}`);
    
    // Get P&L from closed positions (historical record from positions table)
    const closedPositionsPnL = await this.getTotalClosedPositionsPnL();
    
    // Get the count of closed positions
    const closedPositionsCount = this.db.prepare(`
      SELECT COUNT(*) as count FROM positions WHERE status = 'CLOSED'
    `).get() as { count: number };
    console.log(`Closed Positions: ${closedPositionsCount.count}`);
    
    // Get normalized trades P&L (already divided by 1,000,000)
    const tradePnL = await this.getTotalTradesPnL(true);
    
    // Convert all values to dollar-scale
    const activePnLScaled = metrics.profitLoss / 1000000;
    const closedPositionsPnLScaled = closedPositionsPnL / 1000000;
    
    // Log the individual components with more detail
    console.log(`\nCOMPONENTS OF TOTAL P&L:`);
    console.log(`1. Active positions P&L: $${activePnLScaled.toFixed(4)}`);
    console.log(`2. Closed positions P&L: $${closedPositionsPnLScaled.toFixed(4)} (from positions table)`);
    console.log(`3. Trades P&L:           $${tradePnL.toFixed(4)} (from trades table)`);
    
    // Calculate final total 
    const totalPnL = activePnLScaled + tradePnL;
    console.log(`\nFINAL CALCULATION:`);
    console.log(`Total P&L = Active P&L + Trades P&L = $${activePnLScaled.toFixed(4)} + $${tradePnL.toFixed(4)} = $${totalPnL.toFixed(4)}`);
    console.log(`Note: Closed positions P&L ($${closedPositionsPnLScaled.toFixed(4)}) is not added to prevent double-counting`);
    console.log("=========================================\n");
    
    return {
      activePnL: activePnLScaled,
      closedPositionsPnL: closedPositionsPnLScaled,
      tradePnL: tradePnL,
      totalPnL: activePnLScaled + tradePnL
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
