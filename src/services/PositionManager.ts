// src/services/position-manager.ts
import Database from "better-sqlite3";
import { JupiterService } from "./JupiterService";
import { SolanaWalletClient } from "../types/trade";
import { randomUUID } from "../utils/uuid";

export interface Position {
  id: string;
  tokenAddress: string;
  amount: number;
  initialAmount: number;
  entryPrice: number;
  currentPrice: number | null;
  lastUpdated: number;
  profitLoss: number | null;
  highestPrice: number | null;
  profitTaken: number | null;
  trailingStopPrice: number | null;
  profit25pct: boolean;
  profit50pct: boolean;
  profit100pct: boolean;
  status: "ACTIVE" | "CLOSED" | "LIQUIDATED" | "PARTIAL";
}

// Interface for SQLite result records
interface PositionRecord {
  id: string;
  tokenAddress: string;
  amount: number;
  initialAmount: number;
  entryPrice: number;
  currentPrice: number | null;
  lastUpdated: number;
  profitLoss: number | null;
  highestPrice: number | null;
  profitTaken: number | null;
  trailingStopPrice: number | null;
  profit25pct: number; // SQLite stores booleans as 0/1
  profit50pct: number;
  profit100pct: number;
  status: string;
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
        initial_amount NUMERIC NOT NULL,
        entry_price NUMERIC NOT NULL,
        current_price NUMERIC,
        last_updated INTEGER NOT NULL,
        profit_loss NUMERIC,
        highest_price NUMERIC,
        profit_taken NUMERIC,
        trailing_stop_price NUMERIC,
        profit_25pct BOOLEAN DEFAULT 0,
        profit_50pct BOOLEAN DEFAULT 0,
        profit_100pct BOOLEAN DEFAULT 0,
        status TEXT CHECK (status IN ('ACTIVE', 'CLOSED', 'LIQUIDATED', 'PARTIAL'))
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
      id: randomUUID(),
      tokenAddress: params.tokenAddress,
      amount: params.amount,
      initialAmount: params.amount, // Track the initial amount
      entryPrice: params.entryPrice,
      currentPrice: params.entryPrice,
      lastUpdated: Date.now(),
      profitLoss: 0,
      highestPrice: params.entryPrice,
      profitTaken: 0,
      trailingStopPrice: params.entryPrice * 0.85, // Initialize 15% below entry
      profit25pct: false,
      profit50pct: false,
      profit100pct: false,
      status: "ACTIVE",
    };

    this.db
      .prepare(
        `
      INSERT INTO positions (
        id,
        token_address,
        amount,
        initial_amount,
        entry_price,
        current_price,
        last_updated,
        profit_loss,
        highest_price,
        profit_taken,
        trailing_stop_price,
        profit_25pct,
        profit_50pct,
        profit_100pct,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        position.id,
        position.tokenAddress,
        position.amount,
        position.initialAmount,
        position.entryPrice,
        position.currentPrice,
        position.lastUpdated,
        position.profitLoss,
        position.highestPrice,
        position.profitTaken,
        position.trailingStopPrice,
        position.profit25pct ? 1 : 0,
        position.profit50pct ? 1 : 0,
        position.profit100pct ? 1 : 0,
        position.status
      );

    return position;
  }

  async getPosition(id: string): Promise<Position | null> {
    const result = this.db
      .prepare(
        `
      SELECT 
        id,
        token_address as tokenAddress,
        amount,
        initial_amount as initialAmount,
        entry_price as entryPrice,
        current_price as currentPrice,
        last_updated as lastUpdated,
        profit_loss as profitLoss,
        highest_price as highestPrice,
        profit_taken as profitTaken,
        trailing_stop_price as trailingStopPrice,
        profit_25pct as profit25pct,
        profit_50pct as profit50pct,
        profit_100pct as profit100pct,
        status
      FROM positions 
      WHERE id = ?
    `
      )
      .get(id) as PositionRecord | undefined;

    // If no result, return null
    if (!result) return null;
    
    // Convert SQLite result to Position type with boolean conversions
    const position: Position = {
      id: result.id,
      tokenAddress: result.tokenAddress,
      amount: result.amount,
      initialAmount: result.initialAmount,
      entryPrice: result.entryPrice,
      currentPrice: result.currentPrice,
      lastUpdated: result.lastUpdated,
      profitLoss: result.profitLoss,
      highestPrice: result.highestPrice,
      profitTaken: result.profitTaken,
      trailingStopPrice: result.trailingStopPrice,
      profit25pct: !!result.profit25pct,
      profit50pct: !!result.profit50pct,
      profit100pct: !!result.profit100pct,
      status: result.status as Position['status']
    };

    return position;
  }

  async getPositionByToken(tokenAddress: string): Promise<Position | null> {
    const result = this.db
      .prepare(
        `
      SELECT 
        id,
        token_address as tokenAddress,
        amount,
        initial_amount as initialAmount,
        entry_price as entryPrice,
        current_price as currentPrice,
        last_updated as lastUpdated,
        profit_loss as profitLoss,
        highest_price as highestPrice,
        profit_taken as profitTaken,
        trailing_stop_price as trailingStopPrice,
        profit_25pct as profit25pct,
        profit_50pct as profit50pct,
        profit_100pct as profit100pct,
        status
      FROM positions 
      WHERE token_address = ? 
      AND (status = 'ACTIVE' OR status = 'PARTIAL')
    `
      )
      .get(tokenAddress) as PositionRecord | undefined;

    // If no result, return null
    if (!result) return null;
    
    // Convert SQLite result to Position type with boolean conversions
    const position: Position = {
      id: result.id,
      tokenAddress: result.tokenAddress,
      amount: result.amount,
      initialAmount: result.initialAmount,
      entryPrice: result.entryPrice,
      currentPrice: result.currentPrice,
      lastUpdated: result.lastUpdated,
      profitLoss: result.profitLoss,
      highestPrice: result.highestPrice,
      profitTaken: result.profitTaken,
      trailingStopPrice: result.trailingStopPrice,
      profit25pct: !!result.profit25pct,
      profit50pct: !!result.profit50pct,
      profit100pct: !!result.profit100pct,
      status: result.status as Position['status']
    };

    return position;
  }

  async getAllActivePositions(): Promise<Position[]> {
    const results = this.db
      .prepare(
        `
      SELECT 
        id,
        token_address as tokenAddress,
        amount,
        initial_amount as initialAmount,
        entry_price as entryPrice,
        current_price as currentPrice,
        last_updated as lastUpdated,
        profit_loss as profitLoss,
        highest_price as highestPrice,
        profit_taken as profitTaken,
        trailing_stop_price as trailingStopPrice,
        profit_25pct as profit25pct,
        profit_50pct as profit50pct,
        profit_100pct as profit100pct,
        status
      FROM positions 
      WHERE status = 'ACTIVE' OR status = 'PARTIAL'
    `
      )
      .all() as PositionRecord[];

    // Convert each row to a properly typed Position object
    const positions: Position[] = results.map(result => ({
      id: result.id,
      tokenAddress: result.tokenAddress,
      amount: result.amount,
      initialAmount: result.initialAmount,
      entryPrice: result.entryPrice,
      currentPrice: result.currentPrice,
      lastUpdated: result.lastUpdated,
      profitLoss: result.profitLoss,
      highestPrice: result.highestPrice,
      profitTaken: result.profitTaken,
      trailingStopPrice: result.trailingStopPrice,
      profit25pct: !!result.profit25pct,
      profit50pct: !!result.profit50pct,
      profit100pct: !!result.profit100pct,
      status: result.status as Position['status']
    }));

    return positions;
  }

  async updatePosition(
    id: string,
    updates: Partial<Omit<Position, "id">>
  ): Promise<Position | null> {
    const position = await this.getPosition(id);
    if (!position) return null;

    const updatedPosition = { ...position, ...updates };
    updatedPosition.lastUpdated = Date.now();

    const stmt = this.db.prepare(`
      UPDATE positions 
      SET 
        amount = ?,
        initial_amount = ?,
        current_price = ?,
        last_updated = ?,
        profit_loss = ?,
        highest_price = ?,
        profit_taken = ?,
        trailing_stop_price = ?,
        profit_25pct = ?,
        profit_50pct = ?,
        profit_100pct = ?,
        status = ?
      WHERE id = ?
    `);

    stmt.run(
      updatedPosition.amount,
      updatedPosition.initialAmount,
      updatedPosition.currentPrice,
      updatedPosition.lastUpdated,
      updatedPosition.profitLoss,
      updatedPosition.highestPrice,
      updatedPosition.profitTaken,
      updatedPosition.trailingStopPrice,
      updatedPosition.profit25pct ? 1 : 0,
      updatedPosition.profit50pct ? 1 : 0,
      updatedPosition.profit100pct ? 1 : 0,
      updatedPosition.status,
      id
    );

    return updatedPosition;
  }

  /**
   * Partially close a position by selling a specific percentage of tokens
   * Used for progressive profit-taking at different thresholds
   */
  async partiallyClosePosition(id: string, percentageToSell: number): Promise<boolean> {
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

        // Calculate amount to sell (percentage of current holding)
        const amountToSell = position.amount * (percentageToSell / 100);
        const remainingAmount = position.amount - amountToSell;

        console.log(`Partially closing position ${id}: Selling ${percentageToSell}% (${amountToSell} tokens)`);
        console.log(`Will remain with ${remainingAmount} tokens (${(100 - percentageToSell)}% of current holding)`);

        // Get quote for selling tokens back to SOL
        const WRAPPED_SOL = "So11111111111111111111111111111111111111112";
        const quote = await this.jupiterService.getQuote({
          inputMint: position.tokenAddress,
          outputMint: WRAPPED_SOL,
          amount: amountToSell,
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

        // Calculate profit/loss for this partial sale
        const saleValue = Number(result.outputAmount);
        const entryCostOfSoldPortion = amountToSell * position.entryPrice;
        const profitLossOfSale = saleValue - entryCostOfSoldPortion;

        // Total profit taken so far
        const totalProfitTaken = (position.profitTaken || 0) + profitLossOfSale;

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
            amountToSell,
            position.entryPrice,
            tokenInfo.price,
            "PARTIAL",
            profitLossOfSale,
            result.txid
          );

        // Update position 
        await this.updatePosition(id, {
          amount: remainingAmount,
          status: "PARTIAL",
          currentPrice: tokenInfo.price,
          profitTaken: totalProfitTaken
        });

        // Commit the transaction
        this.db.exec("COMMIT");
        console.log(`✅ Position ${id} partially closed. Sold ${percentageToSell}% for ${profitLossOfSale} SOL profit`);
        return true;
      } catch (error) {
        // Rollback on error
        this.db.exec("ROLLBACK");
        console.error(`Error partially closing position ${id}:`, error);
        return false;
      }
    } catch (error) {
      console.error(`Error in partiallyClosePosition for ${id}:`, error);
      return false;
    }
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

        // Add profit from previous partial closings
        const totalProfit = profitLoss + (position.profitTaken || 0);

        // Calculate percentage return relative to initial investment
        const initialValue = position.initialAmount * position.entryPrice;
        const totalReturnPct = (totalProfit / initialValue) * 100;

        console.log(`Position closed with ${totalReturnPct.toFixed(2)}% total return`);

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

        // Update position status
        await this.updatePosition(id, {
          status: "CLOSED",
          lastUpdated: Date.now(),
          profitLoss: totalProfit, // Include all profit taken
          currentPrice: tokenInfo.price,
        });

        // Commit the transaction
        this.db.exec("COMMIT");
        console.log(`✅ Position ${id} closed successfully. Final P&L: ${totalProfit} SOL (${totalReturnPct.toFixed(2)}%)`);
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
        
        // Calculate profit/loss using the remaining amount
        const currentValue = position.amount * currentPrice;
        const entryValue = position.amount * position.entryPrice;
        const profitLoss = currentValue - entryValue;
        
        // Calculate percentage relative to initial investment for decision making
        const initialInvestment = position.initialAmount * position.entryPrice;
        const totalCurrentValue = currentValue + (position.profitTaken || 0);
        const totalProfitLoss = totalCurrentValue - initialInvestment;
        const profitLossPercentage = initialInvestment > 0 ? (totalProfitLoss / initialInvestment) * 100 : 0;

        // Update highest price if current price is higher
        let highestPrice = position.highestPrice || position.entryPrice;
        if (currentPrice > highestPrice) {
          highestPrice = currentPrice;
        }
        
        // Calculate trailing stop price (15% below highest price)
        const newTrailingStopPrice = highestPrice * 0.85;
        
        // Only update trailing stop if it's higher than the previous one (never moves down)
        const trailingStopPrice = position.trailingStopPrice && newTrailingStopPrice > position.trailingStopPrice
          ? newTrailingStopPrice
          : position.trailingStopPrice;

        console.log(`Position update for ${position.tokenAddress}:`, {
          amount: position.amount,
          initialAmount: position.initialAmount, 
          entryPrice: position.entryPrice,
          currentPrice: currentPrice,
          highestPrice: highestPrice,
          trailingStopPrice: trailingStopPrice,
          profitTaken: position.profitTaken || 0,
          totalProfitLoss,
          profitLossPercentage: `${profitLossPercentage.toFixed(2)}%`
        });

        // Update position
        await this.updatePosition(position.id, {
          currentPrice: currentPrice,
          profitLoss: totalProfitLoss,
          highestPrice: highestPrice,
          trailingStopPrice: trailingStopPrice,
          lastUpdated: Date.now(),
        });

        // Check for trailing stop loss (only if trailingStopPrice is defined)
        if (trailingStopPrice && currentPrice <= trailingStopPrice) {
          console.log(`⚠️ Trailing stop triggered for ${position.id} - Current: $${currentPrice} fell below trailing stop: $${trailingStopPrice}`);
          
          // Execute trailing stop by closing the position
          const success = await this.closePosition(position.id);
          if (success) {
            console.log(`✅ Trailing stop executed for position ${position.id}`);
          } else {
            console.error(`❌ Failed to execute trailing stop for position ${position.id}`);
          }
          continue; // Skip further checks since position is closed
        }

        // Progressive profit-taking strategy
        // First target: 30% profit - sell 25% of position
        if (!position.profit25pct && profitLossPercentage >= 30) {
          console.log(`🎯 First profit target hit for ${position.id} (${profitLossPercentage.toFixed(2)}%)`);
          
          // Sell 25% of initial position
          const success = await this.partiallyClosePosition(position.id, 25);
          if (success) {
            console.log(`✅ Sold 25% of position ${position.id} at +30% profit`);
            await this.updatePosition(position.id, { profit25pct: true });
          } else {
            console.error(`❌ Failed to sell 25% of position ${position.id}`);
          }
          continue; // Skip further checks to avoid multiple sells in one update
        }
        
        // Second target: 50% profit - sell 25% of position
        if (position.profit25pct && !position.profit50pct && profitLossPercentage >= 50) {
          console.log(`🎯 Second profit target hit for ${position.id} (${profitLossPercentage.toFixed(2)}%)`);
          
          // Sell 25% of initial position (33% of remaining)
          const success = await this.partiallyClosePosition(position.id, 33);
          if (success) {
            console.log(`✅ Sold another 25% of position ${position.id} at +50% profit`);
            await this.updatePosition(position.id, { profit50pct: true });
          } else {
            console.error(`❌ Failed to sell another 25% of position ${position.id}`);
          }
          continue; // Skip further checks to avoid multiple sells in one update
        }
        
        // Third target: 100% profit - sell 25% of position
        if (position.profit50pct && !position.profit100pct && profitLossPercentage >= 100) {
          console.log(`🎯 Third profit target hit for ${position.id} (${profitLossPercentage.toFixed(2)}%)`);
          
          // Sell 25% of initial position (50% of remaining)
          const success = await this.partiallyClosePosition(position.id, 50);
          if (success) {
            console.log(`✅ Sold another 25% of position ${position.id} at +100% profit`);
            await this.updatePosition(position.id, { profit100pct: true });
          } else {
            console.error(`❌ Failed to sell another 25% of position ${position.id}`);
          }
          continue; // Skip further checks
        }
        
        // Remaining 25% is held for moonshot potential
        // Only trailing stop will exit this portion

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
  
  /**
   * Scale into a position by buying more of a token
   * Used to add to winning positions after they've shown momentum
   */
  async scaleIntoPosition(id: string, additionalInvestmentInSol: number): Promise<boolean> {
    try {
      // Start a database transaction
      this.db.exec("BEGIN TRANSACTION");

      try {
        // Get the position
        const position = await this.getPosition(id);
        if (!position) {
          console.log(`Position ${id} not found`);
          this.db.exec("ROLLBACK");
          return false;
        }
        
        // Don't scale into positions that have already started taking profits
        if (position.profit25pct) {
          console.log(`Not scaling into position ${id} because it has already reached the first profit target`);
          this.db.exec("ROLLBACK");
          return false;
        }

        // Get current token info to verify price movement
        const currentPrice = await this.jupiterService.getCurrentPrice(position.tokenAddress);
        if (currentPrice === null) {
          console.error(`Failed to get current price for ${position.tokenAddress}`);
          this.db.exec("ROLLBACK");
          return false;
        }

        // Calculate profit percentage to decide if this is a winning position worth scaling into
        const profitPercentage = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
        
        // Only scale into positions that are in profit but haven't yet hit the first profit target
        if (profitPercentage < 10 || profitPercentage > 25) {
          console.log(`Not scaling into position ${id} because profit percentage (${profitPercentage.toFixed(2)}%) is outside optimal range`);
          this.db.exec("ROLLBACK");
          return false;
        }

        // Get quote for buying more tokens with SOL
        const WRAPPED_SOL = "So11111111111111111111111111111111111111112";
        const quote = await this.jupiterService.getQuote({
          inputMint: WRAPPED_SOL,
          outputMint: position.tokenAddress,
          amount: additionalInvestmentInSol,
        });

        if (!quote) {
          console.error(`Failed to get quote for buying more ${position.tokenAddress}`);
          this.db.exec("ROLLBACK");
          return false;
        }

        // Execute swap (buy more tokens with SOL)
        const result = await this.jupiterService.executeSwap(quote, this.walletClient);
        if (!result) {
          console.error(`Failed to execute swap for ${position.tokenAddress}`);
          this.db.exec("ROLLBACK");
          return false;
        }

        // Calculate the new average entry price
        const newTokenAmount = Number(result.outputAmount);
        const totalTokens = position.amount + newTokenAmount;
        
        // Calculate blended entry price
        const oldCost = position.amount * position.entryPrice;
        const newCost = additionalInvestmentInSol;
        const blendedEntryPrice = (oldCost + newCost) / totalTokens;
        
        // Record the scale-in action
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
              tx_id
            ) VALUES (?, ?, ?, ?, unixepoch(), ?, ?)
          `
          )
          .run(
            randomUUID(),
            position.tokenAddress,
            newTokenAmount,
            currentPrice,
            "SCALE_IN",
            result.txid
          );

        // Update position with new amount and blended entry price
        await this.updatePosition(id, {
          amount: totalTokens,
          initialAmount: position.initialAmount + newTokenAmount,
          entryPrice: blendedEntryPrice,
          currentPrice: currentPrice
        });

        // Commit the transaction
        this.db.exec("COMMIT");
        console.log(`✅ Successfully scaled into position ${id} with ${additionalInvestmentInSol} SOL, adding ${newTokenAmount} tokens`);
        console.log(`New position size: ${totalTokens} tokens, blended entry price: ${blendedEntryPrice}`);
        return true;
      } catch (error) {
        // Rollback on error
        this.db.exec("ROLLBACK");
        console.error(`Error scaling into position ${id}:`, error);
        return false;
      }
    } catch (error) {
      console.error(`Error in scaleIntoPosition for ${id}:`, error);
      return false;
    }
  }

  /**
   * Checks all positions for ones worth scaling into 
   * and adds to winning positions based on momentum
   */
  async checkForScalingOpportunities(
    maxPositionsToScale: number = 1,
    percentOfBalance: number = 2
  ): Promise<void> {
    try {
      // Get wallet balance to calculate how much we can invest
      const balance = await this.walletClient.balanceOf(
        this.walletClient.getAddress()
      );
      const availableBalance = Number(balance.value);
      
      // Skip if balance is too low
      if (availableBalance < 0.05) {
        console.log("Balance too low for scaling into positions");
        return;
      }

      // Calculate the amount to invest per position
      const investmentAmount = (availableBalance * percentOfBalance) / 100;
      console.log(`Looking for positions to scale into. Will invest ${investmentAmount} SOL per position`);

      // Get all active positions
      const positions = await this.getAllActivePositions();
      if (positions.length === 0) {
        console.log("No active positions to scale into");
        return;
      }

      // Filter positions that meet scaling criteria:
      // 1. Not yet reached first profit target
      // 2. Currently in profit
      // 3. Has momentum (price is higher than entry)
      const candidatePositions = [];
      
      for (const position of positions) {
        // Skip positions that have already had profit taking
        if (position.profit25pct) continue;
        
        // Calculate current profit percentage
        const profitPercentage = position.currentPrice && position.entryPrice
          ? ((position.currentPrice - position.entryPrice) / position.entryPrice) * 100
          : 0;
        
        // Only add positions with profit between 10% and 25%
        if (profitPercentage >= 10 && profitPercentage <= 25) {
          candidatePositions.push({
            position,
            profitPercentage
          });
        }
      }
      
      // Sort candidates by profit percentage (descending)
      candidatePositions.sort((a, b) => b.profitPercentage - a.profitPercentage);
      
      // Scale into top positions up to maxPositionsToScale
      const positionsToScale = candidatePositions.slice(0, maxPositionsToScale);
      
      if (positionsToScale.length === 0) {
        console.log("No suitable positions found for scaling");
        return;
      }
      
      // Execute scaling for each selected position
      for (const { position, profitPercentage } of positionsToScale) {
        console.log(`🔄 Scaling into position ${position.id} (${position.tokenAddress}) with ${profitPercentage.toFixed(2)}% profit`);
        
        const success = await this.scaleIntoPosition(position.id, investmentAmount);
        if (success) {
          console.log(`✅ Successfully scaled into position ${position.id}`);
        } else {
          console.error(`❌ Failed to scale into position ${position.id}`);
        }
      }
    } catch (error) {
      console.error("Error checking for scaling opportunities:", error);
    }
  }

  async getPortfolioMetrics(): Promise<PositionMetrics> {
    const positions = await this.getAllActivePositions();
    let totalValue = 0;
    let totalProfitLoss = 0;
    let totalProfitTaken = 0;

    for (const position of positions) {
      if (position.currentPrice !== null) {
        // Calculate using the amount as is - since we're storing raw amounts
        const value = position.amount * position.currentPrice;
        totalValue += value;
        totalProfitLoss += position.profitLoss || 0;
        totalProfitTaken += position.profitTaken || 0;
      }
    }

    // Total value includes both current holdings and profit already taken
    const totalPortfolioValue = totalValue + totalProfitTaken;

    // Apply scaling in dashboard display but keep raw calculations here
    console.log("Portfolio metrics:", {
      currentHoldings: totalValue,
      profitTaken: totalProfitTaken,
      totalPortfolioValue,
      positions: positions.length
    });

    const profitLossPercentage =
      totalValue > 0 ? (totalProfitLoss / totalValue) * 100 : 0;

    return {
      totalValue: totalPortfolioValue, // Include profit taken
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
