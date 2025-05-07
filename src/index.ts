// index.ts: Web dashboard for portfolio positions running on localhost:3000
import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import morgan from "morgan";
import Database from "better-sqlite3";
import { initializeWalletWithConnection } from "./utils/wallet";
import { createJupiterService } from "./services/JupiterService";
import { createPositionManager, Position } from "./services/PositionManager";
import { Connection } from "@solana/web3.js";
import { SolanaWalletClient } from "./types/trade";
import { formatCurrency, formatTokenAmount, normalizeTokenAmount } from "./utils/token";
import { initializeDatabase as initDb } from "./utils/db-schema";
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
  // Use a relative path if DB_PATH is absolute and starts with / (to prevent root dir issues)
  let dbPath = process.env.DB_PATH;
  if (!dbPath || (dbPath.startsWith('/') && !dbPath.startsWith('/Users'))) {
    dbPath = "./data/trading.db";
  }
  
  console.log(`Connecting to database at ${dbPath}...`);
  
  try {
    // Ensure the directory exists
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      console.log(`Creating database directory: ${dbDir}`);
      fs.mkdirSync(dbDir, { recursive: true });
    }
    
    const sqliteDb = new Database(dbPath, {
      verbose: process.env.DEBUG ? console.log : undefined,
    });

    // Initialize database schema
    initDb(sqliteDb);

    return sqliteDb;
  } catch (error) {
    console.error(`Failed to initialize database at ${dbPath}:`, error);
    throw error;
  }
}

// We're now importing these functions from utils/token.ts

/**
 * Truncate an address to a more readable format
 */
function truncateAddress(address: string, start = 6, end = 4): string {
  if (!address) return "";
  if (address.length <= start + end) return address;
  return `${address.substring(0, start)}...${address.substring(address.length - end)}`;
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
      const walletAddress = walletClient.getAddress ? walletClient.getAddress() : "Unknown";
      console.log(`Wallet address: ${walletAddress}`);
      
      // Check for direct publicKey property
      if (walletClient.publicKey) {
        console.log(`Public key available: ${walletClient.publicKey.toString()}`);
      } else if (walletClient.keypair && walletClient.keypair.publicKey) {
        console.log(`Public key from keypair: ${walletClient.keypair.publicKey.toString()}`);
      } else {
        console.log("No public key directly accessible on wallet client");
      }
    } catch (error) {
      console.error("Error accessing wallet details:", error);
    }
    
    jupiterService = createJupiterService();
    
    // Create position manager
    positionManager = createPositionManager(
      db,
      jupiterService,
      walletClient
    );

    // Initialize Express app
    const app = express();
    const port = process.env.PORT || 3000;

    // Set up view engine and middleware
    app.set("views", path.join(__dirname, "views"));
    app.set("view engine", "ejs");
    app.use(express.static(path.join(__dirname, "public")));
    app.use(morgan("dev"));

    // Create a token cache updater
    async function updateTokenCache() {
      try {
        // Get all token addresses from both positions and trades tables
        const positions = await positionManager.getAllActivePositions();
        const recentTrades = db.prepare(`
          SELECT * FROM trades 
          ORDER BY exit_time DESC 
          LIMIT 10
        `).all();

        const tokenAddresses = new Set<string>();
        
        positions.forEach((pos: Position) => tokenAddresses.add(pos.tokenAddress));
        recentTrades.forEach((trade: any) => tokenAddresses.add(trade.token_address));
        
        // Get token info for each unique address
        for (const address of tokenAddresses) {
          if (!tokenCache[address]) {
            try {
              // First try to get from the tokens table
              const tokenRecord = db.prepare(`
                SELECT symbol, name, decimals FROM tokens WHERE address = ?
              `).get(address) as { symbol: string; name?: string; decimals?: number } | undefined;
              
              if (tokenRecord && tokenRecord.symbol) {
                tokenCache[address] = { 
                  symbol: tokenRecord.symbol, 
                  name: tokenRecord.name || tokenRecord.symbol,
                  decimals: tokenRecord.decimals || 9
                };
              } else {
                // If not in DB, try to get from Jupiter
                const tokenInfo = await jupiterService.getTokenInfo(address);
                if (tokenInfo?.symbol) {
                  tokenCache[address] = { 
                    symbol: tokenInfo.symbol, 
                    name: tokenInfo.name,
                    decimals: tokenInfo.decimals || 9
                  };
                  
                  // Store in DB for future use (including new name field and decimals)
                  db.prepare(`
                    INSERT OR REPLACE INTO tokens (address, symbol, name, decimals, last_updated) 
                    VALUES (?, ?, ?, ?, unixepoch())
                  `).run(
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
                    decimals: 9
                  };
                }
              }
            } catch (error) {
              console.error(`Error fetching token info for ${address}:`, error);
              tokenCache[address] = { symbol: "???", name: "Unknown", decimals: 9 };
            }
          }
        }
      } catch (error) {
        console.error("Error updating token cache:", error);
      }
    }

    // Dashboard route
    app.get("/", async (req, res) => {
      try {
        // Update position prices
        await positionManager.updatePricesAndProfitLoss();
        
        // Get active positions
        const positions = await positionManager.getAllActivePositions();
        
        // Sort positions by profit/loss percentage (descending)
        positions.sort((a: Position, b: Position) => {
          const aPerc = a.profitLoss !== null ? (a.profitLoss / (a.amount * a.entryPrice)) * 100 : -Infinity;
          const bPerc = b.profitLoss !== null ? (b.profitLoss / (b.amount * b.entryPrice)) * 100 : -Infinity;
          return bPerc - aPerc;
        });
        
        // Get portfolio metrics
        const metrics = await positionManager.getPortfolioMetrics();
        
        // Get total P&L from completed trades
        let totalCompletedTradesPnL = 0;
        try {
          const result = db.prepare(`
            SELECT SUM(profit_loss) as total_pnl FROM trades WHERE status = 'CLOSED'
          `).get() as { total_pnl: number | null };
          totalCompletedTradesPnL = result.total_pnl || 0;
        } catch (error) {
          console.error("Error calculating total P&L from completed trades:", error);
        }
        
        // Get SOL balance
        let solBalance = 0;
        let solBalanceInSol = 0;
        let walletAddress = "Unknown";
        
        try {
          // First, try to get the wallet address using the getAddress method
          if (walletClient.getAddress) {
            walletAddress = walletClient.getAddress();
            console.log(`Using wallet address from getAddress(): ${walletAddress}`);
          }
          
          // Get public key object for balance checking
          let publicKey = null;
          
          // Method 1: Direct publicKey property
          if (walletClient.publicKey) {
            publicKey = walletClient.publicKey;
            console.log(`Using direct publicKey property: ${publicKey.toString()}`);
          } 
          // Method 2: From keypair
          else if (walletClient.keypair && walletClient.keypair.publicKey) {
            publicKey = walletClient.keypair.publicKey;
            console.log(`Using keypair.publicKey: ${publicKey.toString()}`);
          }
          // Method 3: From address string using PublicKey constructor
          else if (walletAddress && walletAddress !== "Unknown") {
            try {
              // Convert address string to PublicKey object
              const { PublicKey } = await import('@solana/web3.js');
              publicKey = new PublicKey(walletAddress);
              console.log(`Created PublicKey from address string: ${publicKey.toString()}`);
            } catch (e) {
              console.error(`Failed to create PublicKey from address: ${walletAddress}`, e);
            }
          }
          // Method 4: Try to find any property that looks like a public key
          else {
            for (const key of Object.keys(walletClient)) {
              const value = walletClient[key];
              if (value && typeof value === 'object' && value.toBase58) {
                publicKey = value;
                console.log(`Found publicKey-like object in property '${key}': ${publicKey.toString()}`);
                break;
              }
            }
          }
          
          // If we found a public key, try to get the balance
          if (publicKey) {
            console.log(`Fetching SOL balance for: ${publicKey.toString()}`);
            solBalance = await connection.getBalance(publicKey);
            solBalanceInSol = solBalance / 10**9; // Convert lamports to SOL
            console.log(`SOL balance: ${solBalanceInSol} SOL (${solBalance} lamports)`);
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
        
        // Adjust metrics for display - use 10^6 as standard divisor for token amounts
        // This converts the raw amounts to human-readable amounts
        const adjustedMetrics = {
          totalValue: metrics.totalValue / 1000000,
          profitLoss: metrics.profitLoss / 1000000,
          profitLossPercentage: metrics.profitLossPercentage,
          // Add the total P&L from both active positions and completed trades
          totalPnL: (metrics.profitLoss / 1000000) + (totalCompletedTradesPnL / 1000000)
        };
        
        // Calculate total portfolio value (positions + SOL)
        const totalValueWithSol = adjustedMetrics.totalValue + solValueUsd;
        
        // Get page parameter with default of 1
        const pageParam = req.query.page;
        const page = parseInt(typeof pageParam === 'string' ? pageParam : '1') || 1;
        const tradesPerPage = 20;
        const offset = (page - 1) * tradesPerPage;

        // Get total count of trades with valid dates for pagination
        const totalTradesResult = db.prepare(`
          SELECT COUNT(*) as count FROM trades 
          WHERE exit_time IS NOT NULL AND exit_time > 0
        `).get() as { count: number };
        const totalTrades = totalTradesResult.count;
        const totalPages = Math.ceil(totalTrades / tradesPerPage);

        // Get recent trades with pagination, filtering out items without a valid date
        const recentTrades = db.prepare(`
          SELECT * FROM trades 
          WHERE exit_time IS NOT NULL AND exit_time > 0
          ORDER BY exit_time DESC 
          LIMIT ? OFFSET ?
        `).all(tradesPerPage, offset);
        
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
          totalTrades
        });
      } catch (error) {
        console.error("Error rendering dashboard:", error);
        res.status(500).send(`Error: ${(error as Error).message}`);
      }
    });

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