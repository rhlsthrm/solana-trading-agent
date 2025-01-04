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
    const position = await this.getPosition(id);
    if (!position) return false;

    await this.updatePosition(id, {
      status: "CLOSED",
      lastUpdated: Date.now(),
    });

    return true;
  }

  async updatePricesAndProfitLoss(): Promise<void> {
    const activePositions = await this.getAllActivePositions();

    for (const position of activePositions) {
      try {
        // Get current token info from Jupiter
        const tokenInfo = await this.jupiterService.getTokenInfo(
          position.tokenAddress
        );
        if (!tokenInfo?.price) continue;

        // Calculate profit/loss
        const currentValue = position.amount * tokenInfo.price;
        const entryValue = position.amount * position.entryPrice;
        const profitLoss = currentValue - entryValue;
        const profitLossPercentage = (profitLoss / entryValue) * 100;

        // Update position
        await this.updatePosition(position.id, {
          currentPrice: tokenInfo.price,
          profitLoss,
          lastUpdated: Date.now(),
        });

        // Check for stop loss (example: -15%)
        if (profitLossPercentage < -15) {
          console.log(`⚠️ Stop loss triggered for position ${position.id}`);
          // Implement stop loss logic here
        }
      } catch (error) {
        console.error(`Error updating position ${position.id}:`, error);
      }
    }
  }

  async getPortfolioMetrics(): Promise<PositionMetrics> {
    const positions = await this.getAllActivePositions();
    let totalValue = 0;
    let totalProfitLoss = 0;

    for (const position of positions) {
      if (position.currentPrice) {
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
}

export const createPositionManager = (
  db: Database.Database,
  jupiterService: JupiterService,
  walletClient: SolanaWalletClient
) => {
  return new PositionManager(db, jupiterService, walletClient);
};
