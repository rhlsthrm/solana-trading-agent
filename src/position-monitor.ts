// position-monitor.ts:
import "dotenv/config";
import Database from "better-sqlite3";
import { initializeWalletWithConnection } from "./utils/wallet";
import { createJupiterService } from "./services/JupiterService";
import {
  createPositionManager,
  PositionManager,
} from "./services/PositionManager";

// Default check interval (in milliseconds)
const DEFAULT_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

async function initializeDatabase(): Promise<Database.Database> {
  // Initialize SQLite database
  const sqliteDb = new Database("./trading.db", {
    verbose: process.env.DEBUG ? console.log : undefined,
  });

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

    // Initial check
    console.log(
      "Checking positions for stop-loss and take-profit conditions..."
    );
    await runCheck(positionManager);

    // Set up interval for periodic checking
    setInterval(async () => {
      console.log("\n--- Position Monitor Check ---");
      console.log(new Date().toISOString());
      await runCheck(positionManager);
    }, checkInterval);

    console.log(
      `Position monitor running. Will check every ${
        checkInterval / 1000
      } seconds.`
    );

    // Keep the process running
    await new Promise(() => {});
  } catch (error) {
    console.error("Fatal error in position monitor:", error);
    process.exit(1);
  }
}

async function runCheck(positionManager: PositionManager) {
  try {
    // Get portfolio metrics before update
    const beforeMetrics = await positionManager.getPortfolioMetrics();
    console.log("Portfolio before update:", {
      totalValue: beforeMetrics.totalValue.toFixed(4),
      profitLoss: beforeMetrics.profitLoss.toFixed(4),
      profitLossPercentage: beforeMetrics.profitLossPercentage.toFixed(2) + "%",
    });

    // Get active positions
    const activePositions = await positionManager.getAllActivePositions();
    console.log(`Found ${activePositions.length} active positions`);

    if (activePositions.length === 0) {
      console.log("No active positions to monitor.");
      return;
    }

    // Update prices and check for stop-loss/take-profit conditions
    await positionManager.updatePricesAndProfitLoss();

    // Get portfolio metrics after update
    const afterMetrics = await positionManager.getPortfolioMetrics();
    console.log("Portfolio after update:", {
      totalValue: afterMetrics.totalValue.toFixed(4),
      profitLoss: afterMetrics.profitLoss.toFixed(4),
      profitLossPercentage: afterMetrics.profitLossPercentage.toFixed(2) + "%",
    });

    // Re-check active positions to see what's left after possible auto-closes
    const remainingPositions = await positionManager.getAllActivePositions();

    // Log details of each remaining position
    for (const position of remainingPositions) {
      const entryValue = position.amount * position.entryPrice;
      const currentValue = position.currentPrice
        ? position.amount * position.currentPrice
        : 0;
      const profitLoss = position.profitLoss || 0;
      const profitLossPercentage =
        entryValue > 0 ? (profitLoss / entryValue) * 100 : 0;

      console.log(`Position ${position.id} (${position.tokenAddress}):`);
      console.log(`  Amount: ${position.amount}`);
      console.log(`  Entry Price: ${position.entryPrice}`);
      console.log(`  Current Price: ${position.currentPrice}`);
      console.log(
        `  P&L: ${profitLoss.toFixed(4)} (${profitLossPercentage.toFixed(2)}%)`
      );

      // Warn if position is approaching stop-loss or take-profit
      if (profitLossPercentage < -10 && profitLossPercentage > -15) {
        console.log(
          `  ⚠️ WARNING: Position approaching stop-loss (${profitLossPercentage.toFixed(
            2
          )}%)`
        );
      } else if (profitLossPercentage > 25 && profitLossPercentage < 30) {
        console.log(
          `  ⚠️ WARNING: Position approaching take-profit (${profitLossPercentage.toFixed(
            2
          )}%)`
        );
      }
    }

    console.log(`Monitoring ${remainingPositions.length} active positions`);
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
