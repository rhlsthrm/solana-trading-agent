import { config } from "dotenv";
import type { IAgentRuntime, Memory, State } from "@ai16z/eliza";
import createTradingPlugin from "./index.js";
import Database from "better-sqlite3";

const mockRuntime: Partial<IAgentRuntime> = {
  getSetting: (key: string) => process.env[key] || null,
  agentId: "test-agent" as any,
  modelProvider: "openai" as any,
  character: {
    name: "TestAgent",
    modelProvider: "openai" as any,
    bio: "Test agent",
    lore: ["Test lore"],
    messageExamples: [],
    postExamples: [],
    topics: [],
    adjectives: [],
    clients: [],
    plugins: [],
    style: {
      all: [],
      chat: [],
      post: [],
    },
  },
};

// Add USDC token address to mock message for analysis
const mockMessage: Partial<Memory> = {
  content: { text: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }, // USDC token address
  userId: "test-user" as any,
  roomId: "test-room" as any,
  agentId: "test-agent" as any,
};

const mockState: Partial<State> = {
  userId: "test-user" as any,
  roomId: "test-room" as any,
  bio: "",
  lore: "",
  recentMessages: "",
  actors: "",
};

async function displayTokens(db: Database.Database) {
  console.log("\nStored tokens:");
  const tokens = db
    .prepare("SELECT * FROM tokens ORDER BY liquidity DESC LIMIT 5")
    .all();
  tokens.forEach((token, i) => {
    console.log(`${i + 1}. ${token.symbol}`);
    console.log(`   Address: ${token.address}`);
    console.log(`   Liquidity: $${token.liquidity.toLocaleString()}`);
    console.log(`   24h Volume: $${token.volume_24h.toLocaleString()}`);
    console.log(`   Last Updated: ${token.last_updated}`);
    console.log();
  });
}

async function displayAnalysis(db: Database.Database) {
  console.log("\nLatest Analysis Results:");
  const results = db
    .prepare(
      `
      SELECT a.*, t.symbol 
      FROM analysis a 
      JOIN tokens t ON a.token_address = t.address 
      ORDER BY a.timestamp DESC 
      LIMIT 5
    `
    )
    .all();

  if (results.length === 0) {
    console.log("No analysis results found.");
    return;
  }

  results.forEach((result) => {
    console.log(`Token: ${result.symbol}`);
    console.log(`Timeframe: ${result.timeframe}`);
    console.log(`RSI: ${result.rsi.toFixed(2)}`);
    console.log(`Short MA: ${result.short_ma.toFixed(2)}`);
    console.log(`Long MA: ${result.long_ma.toFixed(2)}`);
    console.log(`Volume MA: ${result.volume_ma.toFixed(2)}`);
    console.log(`Timestamp: ${result.timestamp}`);
    console.log();
  });
}

async function verifyDatabase(db: Database.Database) {
  console.log("\nVerifying database tables...");

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((t) => t.name);

  console.log("Found tables:", tables);

  if (tables.includes("analysis")) {
    const columns = db
      .prepare("PRAGMA table_info(analysis)")
      .all()
      .map((c) => `${c.name} (${c.type})`);

    console.log("\nAnalysis table structure:");
    columns.forEach((col) => console.log(`- ${col}`));
  } else {
    console.log("Analysis table not found!");
  }
}

async function test() {
  // Load environment variables
  config();

  console.log("Starting trading agent test...");

  try {
    console.log("Initializing trading plugin...");
    const plugin = await createTradingPlugin((key) => process.env[key]);

    // Test wallet provider
    console.log("\nTesting wallet provider...");
    const walletProvider = plugin.providers?.[0];
    if (walletProvider) {
      const walletInfo = await walletProvider.get(
        mockRuntime as IAgentRuntime,
        mockMessage as Memory,
        mockState as State
      );
      console.log("Wallet info:", walletInfo);
    } else {
      console.log("No wallet provider found!");
    }

    const db = new Database("trading.db");

    // Verify database setup
    await verifyDatabase(db);

    // Test token scanning
    console.log("\nTesting token scanning...");
    const scanTokensAction = plugin.actions?.find(
      (action) => action.name === "SCAN_TOKENS"
    );
    if (scanTokensAction) {
      console.log("Running SCAN_TOKENS action...");
      const result = await scanTokensAction.handler(
        mockRuntime as IAgentRuntime,
        mockMessage as Memory,
        mockState as State
      );

      if (result) {
        console.log("Token scan completed successfully!");
        await displayTokens(db);
      } else {
        console.log("Token scan failed!");
      }
    }

    // Test token analysis
    console.log("\nTesting token analysis...");
    const analyzeTokenAction = plugin.actions?.find(
      (action) => action.name === "ANALYZE_TOKEN"
    );
    if (analyzeTokenAction) {
      console.log("Running ANALYZE_TOKEN action...");
      const result = await analyzeTokenAction.handler(
        mockRuntime as IAgentRuntime,
        mockMessage as Memory,
        mockState as State
      );

      if (result) {
        console.log("Token analysis completed successfully!");
        await displayAnalysis(db);
      } else {
        console.log("Token analysis failed!");
      }
    }

    // Log available actions
    console.log("\nAvailable actions:");
    plugin.actions?.forEach((action) => {
      console.log(`- ${action.name}: ${action.description}`);
    });

    db.close();
    console.log("\nTest completed successfully!");
  } catch (error) {
    console.error("Test failed:", error);
    console.error(error instanceof Error ? error.stack : String(error));
  }
}

// Run test
test().catch((error) => {
  console.error("Unhandled error in test:", error);
  process.exit(1);
});
