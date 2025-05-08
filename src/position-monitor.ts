// position-monitor.ts:
import "dotenv/config";
import Database from "better-sqlite3";
import { initializeWalletWithConnection } from "./utils/wallet";
import { createJupiterService } from "./services/JupiterService";
import {
  createPositionManager,
  PositionManager,
} from "./services/PositionManager";
import { initializeDatabase as initDb } from "./utils/db-schema";

// Default check interval (in milliseconds)
const DEFAULT_CHECK_INTERVAL = 60 * 1000;

async function initializeDatabase(): Promise<Database.Database> {
  // Use environment variable DB_PATH or fallback to default path
  const dbPath = process.env.DB_PATH;
  console.log(`Connecting to database at ${dbPath}...`);
  
  // Initialize SQLite database
  const sqliteDb = new Database(dbPath, {
    verbose: process.env.DEBUG ? console.log : undefined,
  });

  // Initialize database schema
  initDb(sqliteDb);

  return sqliteDb;
}

async function monitorPositions() {
  console.log("Starting position monitor...");

  // Get check interval from environment or use default
  const checkInterval =
    Number(process.env.CHECK_INTERVAL) || DEFAULT_CHECK_INTERVAL;

  try {
    // Initialize database
    const db = await initializeDatabase();

    // Initialize wallet
    const { walletClient } = await initializeWalletWithConnection();

    // Create Jupiter service
    const jupiterService = createJupiterService();

    // Create position manager
    const positionManager = createPositionManager(
      db,
      jupiterService,
      walletClient
    );

    // Initial check (no logging)
    await runCheck(positionManager);

    // Set up interval for periodic checking (no per-check logging)
    setInterval(async () => {
      await runCheck(positionManager);
    }, checkInterval);

    console.log(`Position monitor running. Interval: ${checkInterval / 1000}s`);

    // Keep the process running
    await new Promise(() => {});
  } catch (error) {
    console.error("Fatal error in position monitor:", error);
    process.exit(1);
  }
}

async function runCheck(positionManager: PositionManager) {
  try {
    // Get active positions
    const activePositions = await positionManager.getAllActivePositions();
    
    if (activePositions.length === 0) {
      return; // No logging needed for no positions
    }

    // Update prices and check for stop-loss/take-profit conditions
    await positionManager.updatePricesAndProfitLoss();

    // Re-check active positions to see what's left after possible auto-closes
    const remainingPositions = await positionManager.getAllActivePositions();
    
    // Log only positions that are approaching thresholds
    for (const position of remainingPositions) {
      if (!position.profitLoss || !position.currentPrice) continue;
      
      const entryValue = position.amount * position.entryPrice;
      const profitLoss = position.profitLoss;
      const profitLossPercentage = entryValue > 0 ? (profitLoss / entryValue) * 100 : 0;

      // Only log warnings for positions approaching thresholds
      if (profitLossPercentage < -10 && profitLossPercentage > -20) {
        console.log(`⚠️ Position ${position.id.substring(0,8)} approaching stop-loss (${profitLossPercentage.toFixed(2)}%)`);
      } else if (profitLossPercentage > 25 && profitLossPercentage < 30) {
        console.log(`⚠️ Position ${position.id.substring(0,8)} approaching take-profit (${profitLossPercentage.toFixed(2)}%)`);
      }
    }
  } catch (error) {
    console.error("Error in position check:", error);
  }
}

// Handle process termination
process.on("SIGINT", async () => {
  console.log("\nGracefully shutting down position monitor...");
  process.exit();
});

// Start the position monitor
monitorPositions().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
