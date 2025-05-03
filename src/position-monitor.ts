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
const DEFAULT_CHECK_INTERVAL = 1 * 60 * 1000; // 1 minute - more frequent price checks

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

    // Update prices and check for progressive profit-taking and trailing stops
    await positionManager.updatePricesAndProfitLoss();

    // Check for scaling opportunities
    console.log("Checking for scaling opportunities...");
    await positionManager.checkForScalingOpportunities(1, 2);

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
      // Calculate values relative to initial position for better accuracy
      const initialInvestment = position.initialAmount * position.entryPrice;
      const currentValue = position.currentPrice
        ? position.amount * position.currentPrice
        : 0;
      const profitLoss = position.profitLoss || 0;
      const profitTaken = position.profitTaken || 0;
      const totalValue = currentValue + profitTaken;
      const profitLossPercentage =
        initialInvestment > 0 ? ((totalValue - initialInvestment) / initialInvestment) * 100 : 0;

      const progressIndicator = getProgressIndicator(position);

      console.log(`Position ${position.id} (${position.tokenAddress}): ${progressIndicator}`);
      console.log(`  Current Amount: ${position.amount} (${((position.amount / position.initialAmount) * 100).toFixed(0)}% of initial)`);
      console.log(`  Initial Amount: ${position.initialAmount}`);
      console.log(`  Entry Price: ${position.entryPrice}`);
      console.log(`  Current Price: ${position.currentPrice || 'Unknown'}`);
      console.log(`  Highest Price: ${position.highestPrice || position.entryPrice}`);
      
      if (position.trailingStopPrice) {
        console.log(`  Trailing Stop: ${position.trailingStopPrice} (${((position.trailingStopPrice / (position.highestPrice || position.entryPrice)) * 100).toFixed(0)}% of highest)`);
      }
      
      if (profitTaken > 0) {
        console.log(`  Profit Already Taken: ${profitTaken.toFixed(4)}`);
      }
      
      console.log(`  Total P&L: ${profitLoss.toFixed(4)} (${profitLossPercentage.toFixed(2)}%)`);

      // Show profit targets
      console.log(`  Profit Targets: ${position.profit25pct ? '✅' : '⬜'} 30% | ${position.profit50pct ? '✅' : '⬜'} 50% | ${position.profit100pct ? '✅' : '⬜'} 100%`);

      // Warn if position is approaching next target
      if (!position.profit25pct && profitLossPercentage > 20 && profitLossPercentage < 30) {
        console.log(`  ⚠️ WARNING: Position approaching first profit target (${profitLossPercentage.toFixed(2)}%)`);
      } else if (position.profit25pct && !position.profit50pct && profitLossPercentage > 40 && profitLossPercentage < 50) {
        console.log(`  ⚠️ WARNING: Position approaching second profit target (${profitLossPercentage.toFixed(2)}%)`);
      } else if (position.profit50pct && !position.profit100pct && profitLossPercentage > 80 && profitLossPercentage < 100) {
        console.log(`  ⚠️ WARNING: Position approaching third profit target (${profitLossPercentage.toFixed(2)}%)`);
      }
      
      // Warn if approaching trailing stop
      if (position.currentPrice && position.trailingStopPrice) {
        const distanceToStop = (position.currentPrice - position.trailingStopPrice) / position.currentPrice * 100;
        if (distanceToStop < 5) {
          console.log(`  ⚠️ WARNING: Position within 5% of trailing stop (${distanceToStop.toFixed(2)}% away)`);
        }
      }
    }

    console.log(`Monitoring ${remainingPositions.length} active positions`);
  } catch (error) {
    console.error("Error in position check:", error);
  }
}

// Helper function to generate visual indicator of position progress
function getProgressIndicator(position: any): string {
  if (!position.currentPrice || !position.entryPrice) return "❓";
  
  const initialInvestment = position.initialAmount * position.entryPrice;
  const currentValue = position.amount * position.currentPrice;
  const profitTaken = position.profitTaken || 0;
  const totalValue = currentValue + profitTaken;
  const profitLossPercentage = ((totalValue - initialInvestment) / initialInvestment) * 100;
  
  if (profitLossPercentage <= -10) return "🔴";
  if (profitLossPercentage < 0) return "🟠";
  if (profitLossPercentage < 10) return "🟡";
  if (profitLossPercentage < 30) return "🟢";
  if (profitLossPercentage < 50) return "💚";
  if (profitLossPercentage < 100) return "💰";
  return "🚀";
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
