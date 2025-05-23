// index.ts: Web dashboard for portfolio positions running on localhost:3000
import "dotenv/config";
import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import path from "path";
import { fileURLToPath } from "url";
import morgan from "morgan";
import Database from "better-sqlite3";
import { initializeWalletWithConnection } from "./utils/wallet";
import { createJupiterService } from "./services/JupiterService";
import { createPositionManager, Position } from "./services/PositionManager";
import { Connection } from "@solana/web3.js";
import { SolanaWalletClient } from "./types/trade";
import {
  formatCurrency,
  formatTokenAmount,
  normalizeTokenAmount,
} from "./utils/token";
import { initializeDatabase as initDb } from "./utils/db-schema";
import { randomUUID } from "./utils/uuid";
import fs from "fs";

// Get the directory name using ESM pattern
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Global variables to hold our services
let db: Database.Database;
let jupiterService: any;
let positionManager: any;
let walletClient: SolanaWalletClient;
let connection: Connection;
let tokenCache: Record<string, any> = {};

async function initializeDatabase(): Promise<Database.Database> {
  const dbPath =
    process.env.DB_PATH || path.resolve(__dirname, "../data/trading.db");
  console.log(`Connecting to database at ${dbPath}...`);

  const sqliteDb = new Database(dbPath, {
    verbose: process.env.DEBUG ? console.log : undefined,
  });

  // Initialize database schema
  initDb(sqliteDb);

  return sqliteDb;
}

// We're now importing these functions from utils/token.ts

/**
 * Truncate an address to a more readable format
 */
function truncateAddress(address: string, start = 6, end = 4): string {
  if (!address) return "";
  if (address.length <= start + end) return address;
  return `${address.substring(0, start)}...${address.substring(
    address.length - end
  )}`;
}

/**
 * Main app function
 */
async function main() {
  try {
    // Initialize services
    db = await initializeDatabase();

    // Initialize wallet
    const walletData = await initializeWalletWithConnection();
    walletClient = walletData.walletClient;
    connection = walletData.connection;

    // Log more detailed wallet initialization info for debugging
    console.log("Wallet initialized successfully");

    // Check if we can access the wallet's public key and log it
    try {
      const walletAddress = walletClient.getAddress
        ? walletClient.getAddress()
        : "Unknown";
      console.log(`Wallet address: ${walletAddress}`);

      // Check for direct publicKey property
      if (walletClient.publicKey) {
        console.log(
          `Public key available: ${walletClient.publicKey.toString()}`
        );
      } else if (walletClient.keypair && walletClient.keypair.publicKey) {
        console.log(
          `Public key from keypair: ${walletClient.keypair.publicKey.toString()}`
        );
      } else {
        console.log("No public key directly accessible on wallet client");
      }
    } catch (error) {
      console.error("Error accessing wallet details:", error);
    }

    jupiterService = createJupiterService();

    // Create position manager
    positionManager = createPositionManager(db, jupiterService, walletClient);

    // Initialize Express app
    const app = express();
    const port = process.env.PORT || 3000;

    // Set up view engine and middleware
    app.set("views", path.join(__dirname, "views"));
    app.set("view engine", "ejs");
    app.use(express.static(path.join(__dirname, "public")));
    app.use(express.json()); // For parsing application/json
    app.use(morgan("dev"));

    // Create a token cache updater
    async function updateTokenCache() {
      try {
        // Get all token addresses from both positions and trades tables
        const positions = await positionManager.getAllActivePositions();
        const recentTrades = db
          .prepare(
            `
          SELECT * FROM trades 
          ORDER BY exit_time DESC 
          LIMIT 10
        `
          )
          .all();

        const tokenAddresses = new Set<string>();

        positions.forEach((pos: Position) =>
          tokenAddresses.add(pos.tokenAddress)
        );
        recentTrades.forEach((trade: any) =>
          tokenAddresses.add(trade.token_address)
        );

        // Get token info for each unique address
        for (const address of tokenAddresses) {
          if (!tokenCache[address]) {
            try {
              // First try to get from the tokens table
              const tokenRecord = db
                .prepare(
                  `
                SELECT symbol, name, decimals FROM tokens WHERE address = ?
              `
                )
                .get(address) as
                | { symbol: string; name?: string; decimals?: number }
                | undefined;

              if (tokenRecord && tokenRecord.symbol) {
                tokenCache[address] = {
                  symbol: tokenRecord.symbol,
                  name: tokenRecord.name || tokenRecord.symbol,
                  decimals: tokenRecord.decimals || 9,
                };
              } else {
                // If not in DB, try to get from Jupiter
                const tokenInfo = await jupiterService.getTokenInfo(address);
                if (tokenInfo?.symbol) {
                  tokenCache[address] = {
                    symbol: tokenInfo.symbol,
                    name: tokenInfo.name,
                    decimals: tokenInfo.decimals || 9,
                  };

                  // Store in DB for future use (including new name field and decimals)
                  db.prepare(
                    `
                    INSERT OR REPLACE INTO tokens (address, symbol, name, decimals, last_updated) 
                    VALUES (?, ?, ?, ?, unixepoch())
                  `
                  ).run(
                    address,
                    tokenInfo.symbol,
                    tokenInfo.name || tokenInfo.symbol,
                    tokenInfo.decimals || 9
                  );
                } else {
                  // If all else fails, use address substring as fallback
                  tokenCache[address] = {
                    symbol: address.substring(0, 5),
                    name: address.substring(0, 8),
                    decimals: 9,
                  };
                }
              }
            } catch (error) {
              console.error(`Error fetching token info for ${address}:`, error);
              tokenCache[address] = {
                symbol: "???",
                name: "Unknown",
                decimals: 9,
              };
            }
          }
        }
      } catch (error) {
        console.error("Error updating token cache:", error);
      }
    }

    // Dashboard route
    app.get("/", (async (req: Request, res: Response) => {
      try {
        // Update position prices
        await positionManager.updatePricesAndProfitLoss();

        // Get active positions
        const positions = await positionManager.getAllActivePositions();

        // Sort positions by profit/loss percentage (descending)
        positions.sort((a: Position, b: Position) => {
          const aPerc =
            a.profitLoss !== null
              ? (a.profitLoss / (a.amount * a.entryPrice)) * 100
              : -Infinity;
          const bPerc =
            b.profitLoss !== null
              ? (b.profitLoss / (b.amount * b.entryPrice)) * 100
              : -Infinity;
          return bPerc - aPerc;
        });

        // Get portfolio metrics (now calculated correctly using token-specific decimals)
        const metrics = await positionManager.getPortfolioMetrics();

        // Get comprehensive P&L data from all sources
        const pnlData = await positionManager.getComprehensivePnL();

        // Get SOL balance
        let solBalance = 0;
        let solBalanceInSol = 0;
        let walletAddress = "Unknown";

        try {
          // First, try to get the wallet address using the getAddress method
          if (walletClient.getAddress) {
            walletAddress = walletClient.getAddress();
          }

          // Get public key object for balance checking
          let publicKey = null;

          // Method 1: Direct publicKey property
          if (walletClient.publicKey) {
            publicKey = walletClient.publicKey;
          }
          // Method 2: From keypair
          else if (walletClient.keypair && walletClient.keypair.publicKey) {
            publicKey = walletClient.keypair.publicKey;
          }
          // Method 3: From address string using PublicKey constructor
          else if (walletAddress && walletAddress !== "Unknown") {
            try {
              // Convert address string to PublicKey object
              const { PublicKey } = await import("@solana/web3.js");
              publicKey = new PublicKey(walletAddress);
            } catch (e) {
              console.error(
                `Failed to create PublicKey from address: ${walletAddress}`,
                e
              );
            }
          }
          // Method 4: Try to find any property that looks like a public key
          else {
            for (const key of Object.keys(walletClient)) {
              const value = walletClient[key];
              if (value && typeof value === "object" && value.toBase58) {
                publicKey = value;
                break;
              }
            }
          }

          // If we found a public key, try to get the balance
          if (publicKey) {
            solBalance = await connection.getBalance(publicKey);
            solBalanceInSol = solBalance / 10 ** 9; // Convert lamports to SOL
          } else {
            console.warn("No publicKey available to fetch SOL balance");
          }
        } catch (error) {
          console.error("Error fetching SOL balance:", error);
        }

        // Get latest SOL price
        let solPrice = 0;
        try {
          const WRAPPED_SOL = "So11111111111111111111111111111111111111112";
          const solInfo = await jupiterService.getTokenInfo(WRAPPED_SOL);
          solPrice = solInfo?.price || 0;
        } catch (error) {
          console.error("Error fetching SOL price:", error);
        }

        // Calculate SOL value in USD
        const solValueUsd = solBalanceInSol * solPrice;

        const adjustedMetrics = {
          totalValue: metrics.totalValue,
          profitLoss: metrics.profitLoss,
          profitLossPercentage: metrics.profitLossPercentage,
          // Use the comprehensive P&L data
          totalPnL: pnlData.totalPnL,
        };

        // Calculate total portfolio value (positions + SOL)
        const totalValueWithSol = adjustedMetrics.totalValue + solValueUsd;

        // Get page parameter with default of 1
        const pageParam = req.query.page;
        const page =
          parseInt(typeof pageParam === "string" ? pageParam : "1") || 1;
        const tradesPerPage = 20;
        const offset = (page - 1) * tradesPerPage;

        // Get total count of trades with valid dates for pagination
        const totalTradesResult = db
          .prepare(
            `
          SELECT COUNT(*) as count FROM trades 
          WHERE exit_time IS NOT NULL AND exit_time > 0
        `
          )
          .get() as { count: number };
        const totalTrades = totalTradesResult.count;
        const totalPages = Math.ceil(totalTrades / tradesPerPage);

        // Get recent trades with pagination, filtering out items without a valid date
        const recentTrades = db
          .prepare(
            `
          SELECT * FROM trades 
          WHERE exit_time IS NOT NULL AND exit_time > 0
          ORDER BY exit_time DESC 
          LIMIT ? OFFSET ?
        `
          )
          .all(tradesPerPage, offset);

        // Update token cache
        await updateTokenCache();

        // Render the dashboard with all data
        res.render("dashboard", {
          positions,
          metrics: adjustedMetrics,
          recentTrades,
          solBalance: solBalanceInSol,
          solValueUsd,
          totalValueWithSol,
          walletAddress, // Add wallet address to template data
          tokenMap: tokenCache,
          formatCurrency,
          formatTokenAmount,
          truncateAddress,
          normalizeTokenAmount,
          // Pagination data
          currentPage: page,
          totalPages,
          totalTrades,
        });
      } catch (error) {
        console.error("Error rendering dashboard:", error);
        res.status(500).send(`Error: ${(error as Error).message}`);
      }
    }) as RequestHandler);

    // API endpoint for balance history data
    app.get("/api/balance-history", (async (req: Request, res: Response) => {
      try {
        const days = parseInt(req.query.days as string) || 30;
        const balanceHistory = await positionManager.getDailyBalanceHistory(
          days
        );
        res.json(balanceHistory);
      } catch (error) {
        console.error("Error fetching balance history:", error);
        res.status(500).json({ error: (error as Error).message });
      }
    }) as RequestHandler);

    // API endpoint for closing a position
    app.post("/api/position/close/:id", (async (
      req: Request,
      res: Response
    ) => {
      try {
        const positionId = req.params.id;

        // Get the position first to calculate profit/loss later
        const position = await positionManager.getPosition(positionId);
        if (!position) {
          return res.status(404).json({
            success: false,
            error: "Position not found",
          });
        }

        // Calculate profit/loss for the response
        let profitLoss = 0;
        if (position.entryPrice && position.currentPrice) {
          // Get token decimals from the database
          const tokenRecord = db
            .prepare("SELECT decimals FROM tokens WHERE address = ?")
            .get(position.tokenAddress) as { decimals?: number } | undefined;

          // Default to 9 decimals if not found
          const tokenDecimals = tokenRecord?.decimals || 9;

          // Import the function dynamically
          const { normalizeTokenAmount } = await import("./utils/token");

          // Calculate using normalized amount (same as in the UI)
          const normalizedAmount = normalizeTokenAmount(
            position.amount,
            tokenDecimals
          );
          const entryValue = normalizedAmount * position.entryPrice;
          const currentValue = normalizedAmount * position.currentPrice;
          profitLoss = currentValue - entryValue;
        }

        // Attempt to close the position
        const success = await positionManager.closePosition(positionId);

        if (success) {
          res.json({
            success: true,
            message: "Position closed successfully",
            profitLoss,
          });
        } else {
          res.status(500).json({
            success: false,
            error: "Failed to close position",
          });
        }
      } catch (error) {
        console.error(`Error closing position:`, error);
        res.status(500).json({
          success: false,
          error: (error as Error).message,
        });
      }
    }) as RequestHandler);

    // API endpoint for deleting a position without selling tokens
    app.post("/api/position/delete/:id", (async (
      req: Request,
      res: Response
    ) => {
      try {
        const positionId = req.params.id;

        // Get the position to make sure it exists
        const position = await positionManager.getPosition(positionId);
        if (!position) {
          return res.status(404).json({
            success: false,
            error: "Position not found",
          });
        }

        // Calculate profit/loss for the response
        let profitLoss = 0;
        if (position.entryPrice && position.currentPrice) {
          // Get token decimals from the database
          const tokenRecord = db
            .prepare("SELECT decimals FROM tokens WHERE address = ?")
            .get(position.tokenAddress) as { decimals?: number } | undefined;

          // Default to 9 decimals if not found
          const tokenDecimals = tokenRecord?.decimals || 9;

          // Import the function dynamically
          const { normalizeTokenAmount } = await import("./utils/token");

          // Calculate using normalized amount (same as in the UI)
          const normalizedAmount = normalizeTokenAmount(
            position.amount,
            tokenDecimals
          );
          const entryValue = normalizedAmount * position.entryPrice;
          const currentValue = normalizedAmount * position.currentPrice;
          profitLoss = currentValue - entryValue;
        }

        // Simply update the position status to CLOSED directly in the database
        try {
          // Start a database transaction
          db.exec("BEGIN TRANSACTION");

          // Update position status to CLOSED
          await positionManager.updatePosition(positionId, {
            status: "CLOSED",
            lastUpdated: Date.now(),
          });

          // Add a record in trades table for accounting purposes
          if (position.currentPrice) {
            db.prepare(
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
              ) VALUES (?, ?, ?, ?, ?, unixepoch(), ?, ?, 'manual_delete')
            `
            ).run(
              randomUUID(),
              position.tokenAddress,
              position.amount,
              position.entryPrice,
              position.currentPrice,
              "CLOSED",
              profitLoss
            );
          }

          // Commit the transaction
          db.exec("COMMIT");

          console.log(
            `🗑️ Position ${positionId} manually deleted. P&L: ${profitLoss}`
          );

          res.json({
            success: true,
            message: "Position deleted successfully",
            profitLoss,
          });
        } catch (error) {
          // Rollback on error
          db.exec("ROLLBACK");
          console.error(`Error deleting position ${positionId}:`, error);
          res.status(500).json({
            success: false,
            error: "Failed to delete position",
          });
        }
      } catch (error) {
        console.error(`Error deleting position:`, error);
        res.status(500).json({
          success: false,
          error: (error as Error).message,
        });
      }
    }) as RequestHandler);

    // Start the server
    app.listen(port, () => {
      console.log(`🚀 Dashboard running at http://localhost:${port}`);
      console.log(`Press Ctrl+C to stop the server`);
    });
  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  }
}

// Handle process termination
process.on("SIGINT", async () => {
  console.log("\nGracefully shutting down dashboard...");
  process.exit();
});

// Start the dashboard
main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
