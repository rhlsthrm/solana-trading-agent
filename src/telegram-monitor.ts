// telegram-monitor.ts:
import "dotenv/config";
import { AgentRuntime } from "@elizaos/core";
import { createTelegramMonitorService } from "./services/TelegramMonitorService";
import { ModelProviderName } from "@elizaos/core";
import { jupiter } from "@goat-sdk/plugin-jupiter";
import Database from "better-sqlite3";
import { SqliteDatabaseAdapter } from "@elizaos/adapter-sqlite";
import { degen } from "./characters/degen";
import { initializeWalletWithConnection } from "./utils/wallet";
import { createJupiterService } from "./services/JupiterService";
import { createTradeExecutionService } from "./services/TradeExecutionService";
import { createProficyService } from "./services/ProficyService";
import { createSentimentAnalysisService } from "./services/SentimentAnalysisService";
import { createPositionManager } from "./services/PositionManager";
import { elizaSchema, telegramSchema, tradingSchema } from "./utils/db-schema";

async function initializeDatabase(): Promise<Database.Database> {
  // Use environment variable DB_PATH or fallback to default path
  const dbPath = process.env.DB_PATH;
  console.log(`Connecting to database at ${dbPath}...`);
  
  // Initialize SQLite database with schema
  const sqliteDb = new Database(dbPath, {
    verbose: process.env.DEBUG ? console.log : undefined,
  });

  // Execute schema creation in a transaction
  sqliteDb.exec("BEGIN TRANSACTION;");
  try {
    sqliteDb.exec(elizaSchema);
    sqliteDb.exec(tradingSchema); // Use shared schema for common tables
    sqliteDb.exec(telegramSchema); // Add telegram-specific tables
    sqliteDb.exec("COMMIT;");
    console.log("Database schema created successfully");
  } catch (error) {
    sqliteDb.exec("ROLLBACK;");
    console.error("Error creating database schema:", error);
    throw error;
  }

  return sqliteDb;
}

async function createRuntime(dbAdapter: SqliteDatabaseAdapter) {
  // Create runtime
  return new AgentRuntime({
    modelProvider: ModelProviderName.ANTHROPIC,
    databaseAdapter: dbAdapter,
    token: process.env.ANTHROPIC_API_KEY || "",
    character: degen,
    providers: [],
    actions: [],
    // @ts-ignore
    plugins: [jupiter()],
  });
}

async function main() {
  if (!process.env.TELEGRAM_API_ID || !process.env.TELEGRAM_API_HASH) {
    console.error(
      "Please set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env file"
    );
    process.exit(1);
  }

  try {
    // Initialize database
    const sqliteDb = await initializeDatabase();
    const dbAdapter = new SqliteDatabaseAdapter(sqliteDb);

    // Initialize wallet
    const { walletClient } = await initializeWalletWithConnection();

    // Create runtime
    const runtime = await createRuntime(dbAdapter);

    const jupiterService = createJupiterService();

    const positionManager = createPositionManager(
      sqliteDb,
      jupiterService,
      walletClient
    );

    const tradeExecutionService = createTradeExecutionService(
      jupiterService,
      walletClient,
      sqliteDb,
      runtime,
      positionManager
    );

    const proficyService = createProficyService({
      apiId: Number(process.env.TELEGRAM_API_ID),
      apiHash: process.env.TELEGRAM_API_HASH,
      sessionStr: process.env.TELEGRAM_SESSION,
      runtime,
      db: sqliteDb,
    });

    const sentimentService = createSentimentAnalysisService(runtime);

    await proficyService.init();

    // Initialize Telegram monitor
    const telegramMonitor = createTelegramMonitorService({
      apiId: Number(process.env.TELEGRAM_API_ID),
      apiHash: process.env.TELEGRAM_API_HASH,
      sessionStr: process.env.TELEGRAM_SESSION,
      runtime: runtime,
      db: sqliteDb, // Pass your database instance
      jupiterService: jupiterService, // Pass your Jupiter service instance
      tradeExecutionService: tradeExecutionService,
      proficyService: proficyService,
      sentimentService: sentimentService,
    });

    // Start the Telegram monitor
    await telegramMonitor.start();

    await new Promise(() => {});
  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  }
}

// Handle process termination
process.on("SIGINT", async () => {
  console.log("\nGracefully shutting down...");
  // Add cleanup code here if needed
  process.exit();
});

main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
