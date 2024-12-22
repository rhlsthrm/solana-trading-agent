import "dotenv/config";
import { AgentRuntime, DatabaseAdapter } from "@ai16z/eliza";
import { solana } from "@goat-sdk/wallet-solana";
import { createTelegramMonitorService } from "./services/telegram";
import { Keypair, Connection } from "@solana/web3.js";
import { ModelProviderName } from "@ai16z/eliza";
import { jupiter } from "@goat-sdk/plugin-jupiter";
import Database from "better-sqlite3";
import { SqliteDatabaseAdapter } from "@ai16z/adapter-sqlite";
import { createKeypairFromSecret } from "./utils/solana";

async function initializeDatabase(): Promise<Database.Database> {
  // Initialize SQLite database with schema
  const sqliteDb = new Database("./trading.db", {
    verbose: console.log,
  });

  // Create required tables for ELIZA
  const elizaSchema = `
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      "createdAt" INTEGER DEFAULT (unixepoch()),
      "name" TEXT,
      "username" TEXT,
      "email" TEXT,
      "avatarUrl" TEXT,
      "details" TEXT
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      "createdAt" INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding BLOB,
      userId TEXT NOT NULL,
      roomId TEXT NOT NULL,
      agentId TEXT NOT NULL,
      "unique" INTEGER DEFAULT 0,
      createdAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY,
      "createdAt" INTEGER DEFAULT (unixepoch()),
      "userId" TEXT,
      "roomId" TEXT,
      "userState" TEXT,
      "last_message_read" TEXT,
      FOREIGN KEY ("userId") REFERENCES accounts(id),
      FOREIGN KEY ("roomId") REFERENCES rooms(id)
    );
  `;

  // Create trading-specific tables
  const tradingSchema = `
    CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY,
      source TEXT,
      token_address TEXT,
      signal_type TEXT,
      price NUMERIC,
      timestamp INTEGER DEFAULT (unixepoch()),
      processed INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      token_address TEXT,
      entry_price NUMERIC,
      exit_price NUMERIC,
      position_size NUMERIC,
      signal_id TEXT,
      entry_time INTEGER,
      exit_time INTEGER,
      profit_loss NUMERIC,
      status TEXT,
      FOREIGN KEY (signal_id) REFERENCES signals(id)
    );

    CREATE TABLE IF NOT EXISTS tokens (
      address TEXT PRIMARY KEY,
      symbol TEXT,
      liquidity NUMERIC,
      volume_24h NUMERIC,
      last_updated INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_address TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      rsi NUMERIC,
      short_ma NUMERIC,
      long_ma NUMERIC,
      volume_ma NUMERIC,
      timestamp INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (token_address) REFERENCES tokens(address)
    );
  `;

  // Execute schema creation in a transaction
  sqliteDb.exec("BEGIN TRANSACTION;");
  try {
    sqliteDb.exec(elizaSchema);
    sqliteDb.exec(tradingSchema);
    sqliteDb.exec("COMMIT;");
    console.log("Database schema created successfully");
  } catch (error) {
    sqliteDb.exec("ROLLBACK;");
    console.error("Error creating database schema:", error);
    throw error;
  }

  return sqliteDb;
}

async function initializeWallet() {
  // Create Solana wallet client
  const privateKey = process.env.SOLANA_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("SOLANA_PRIVATE_KEY is not set or invalid in .env");
  }

  let keypair;
  try {
    keypair = createKeypairFromSecret(privateKey);
    console.log(`Wallet public key: ${keypair.publicKey.toString()}`);
  } catch (err) {
    throw new Error(`Failed to parse the private key: ${err}`);
  }

  const connection = new Connection(
    process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
    "confirmed"
  );

  // Create wallet client
  return {
    walletClient: solana({
      keypair,
      connection,
    }),
    connection,
  };
}

async function createRuntime(dbAdapter: SqliteDatabaseAdapter) {
  // Create runtime
  return new AgentRuntime({
    modelProvider: ModelProviderName.ANTHROPIC,
    databaseAdapter: dbAdapter,
    token: process.env.ANTHROPIC_API_KEY || "",
    character: {
      name: "TelegramTradeBot",
      modelProvider: ModelProviderName.ANTHROPIC,
      settings: {
        model: "claude-3-opus-20240229",
        secrets: {
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
        },
      },
      bio: "Autonomous Solana trading bot monitoring Telegram signals",
      lore: [
        "This bot monitors Telegram channels for trading signals and executes trades on Solana.",
        "It uses technical analysis to validate signals before trading.",
        "Risk management and position sizing are key priorities.",
      ],
      messageExamples: [
        [
          {
            user: "User123",
            content: {
              text: "What signals are you monitoring?",
            },
          },
          {
            user: "TelegramTradeBot",
            content: {
              text: "I'm currently monitoring @DegenSeals for trading signals. Each signal is validated using technical analysis before any trade execution.",
            },
          },
        ],
      ],
      postExamples: [
        "New signal detected from @DegenSeals - Analyzing technical indicators...",
        "Trade executed: Bought TOKEN at $1.50 with strict stop loss at $1.35",
      ],
      topics: ["Solana", "Trading", "Technical Analysis", "Risk Management"],
      plugins: [],
      adjectives: ["Analytical", "Cautious", "Precise", "Data-driven"],
      clients: [],
      style: {
        all: ["Professional", "Data-focused", "Risk-aware"],
        chat: ["Clear", "Precise", "Technical"],
        post: ["Factual", "Analytical", "Risk-focused"],
      },
    },
    providers: [],
    actions: [],
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
    await initializeWallet();

    // Create runtime
    const runtime = await createRuntime(dbAdapter);

    // Initialize Telegram monitor
    const telegramMonitor = createTelegramMonitorService({
      apiId: Number(process.env.TELEGRAM_API_ID),
      apiHash: process.env.TELEGRAM_API_HASH,
      sessionStr: process.env.TELEGRAM_SESSION,
      runtime: runtime,
    });

    console.log("Starting Telegram monitor...");
    await telegramMonitor.start();

    // Keep the process running
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
