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

/**
 * Initialize the database connection
 */
async function initializeDatabase(): Promise<Database.Database> {
  console.log("Connecting to database...");
  const sqliteDb = new Database("./trading.db", {
    verbose: process.env.DEBUG ? console.log : undefined,
  });
  return sqliteDb;
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
    
    // Debug the wallet structure to understand its properties
    console.log("Wallet initialized, structure:", {
      hasPublicKey: !!walletClient.publicKey,
      publicKeyType: walletClient.publicKey ? typeof walletClient.publicKey : 'undefined',
      hasKeypair: !!walletClient.keypair,
      hasAddress: !!walletClient.address,
      walletKeys: Object.keys(walletClient)
    });
    
    // Create Jupiter service
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
                SELECT symbol FROM tokens WHERE address = ?
              `).get(address);
              
              if (tokenRecord?.symbol) {
                tokenCache[address] = { symbol: tokenRecord.symbol };
              } else {
                // If not in DB, try to get from Jupiter
                const tokenInfo = await jupiterService.getTokenInfo(address);
                if (tokenInfo?.symbol) {
                  tokenCache[address] = { 
                    symbol: tokenInfo.symbol, 
                    name: tokenInfo.name 
                  };
                  
                  // Store in DB for future use
                  db.prepare(`
                    INSERT OR REPLACE INTO tokens (address, symbol, last_updated) 
                    VALUES (?, ?, unixepoch())
                  `).run(address, tokenInfo.symbol);
                } else {
                  tokenCache[address] = { symbol: "???" };
                }
              }
            } catch (error) {
              console.error(`Error fetching token info for ${address}:`, error);
              tokenCache[address] = { symbol: "???" };
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
        
        // Get SOL balance
        let solBalance = 0;
        let solBalanceInSol = 0;
        
        try {
          // Try multiple approaches to get the public key from the wallet
          let publicKey = null;
          
          // Method 1: Direct publicKey property
          if (walletClient.publicKey) {
            publicKey = walletClient.publicKey;
          } 
          // Method 2: From keypair
          else if (walletClient.keypair && walletClient.keypair.publicKey) {
            publicKey = walletClient.keypair.publicKey;
          }
          // Method 3: From address string
          else if (walletClient.address) {
            console.log("Using wallet address instead of public key:", walletClient.address);
            // We don't have a direct public key, so we'll just show the address in the UI
            solBalanceInSol = 0; // Can't fetch balance without PublicKey object
          }
          // Method 4: Try to find any property that looks like a public key
          else {
            // Look for any property that might contain the public key
            for (const key of Object.keys(walletClient)) {
              const value = walletClient[key];
              if (value && typeof value === 'object' && value.toBase58) {
                publicKey = value;
                console.log(`Found public key in property: ${key}`);
                break;
              }
            }
          }
          
          // If we found a public key, try to get the balance
          if (publicKey) {
            solBalance = await connection.getBalance(publicKey);
            solBalanceInSol = solBalance / 10**9; // Convert lamports to SOL
            console.log(`Found SOL balance: ${solBalanceInSol} SOL`);
          } else {
            console.warn("Could not determine wallet public key for balance check");
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
          profitLossPercentage: metrics.profitLossPercentage
        };
        
        console.log("Adjusted metrics for display:", {
          raw: metrics,
          adjusted: adjustedMetrics
        });
        
        // Calculate total portfolio value (positions + SOL)
        const totalValueWithSol = adjustedMetrics.totalValue + solValueUsd;
        
        // Get recent trades
        const recentTrades = db.prepare(`
          SELECT * FROM trades 
          ORDER BY exit_time DESC 
          LIMIT 10
        `).all();
        
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
          tokenMap: tokenCache,
          formatCurrency,
          formatTokenAmount,
          truncateAddress,
          normalizeTokenAmount
        });
      } catch (error) {
        console.error("Error rendering dashboard:", error);
        res.status(500).send(`Error: ${error.message}`);
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