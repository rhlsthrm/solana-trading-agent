// src/test.ts
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

const mockMessage: Partial<Memory> = {
  content: { text: "Test message" },
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

        // Display stored tokens
        const db = new Database("trading.db");
        await displayTokens(db);
        db.close();
      } else {
        console.log("Token scan failed!");
      }
    } else {
      console.log("SCAN_TOKENS action not found!");
    }

    // Log available actions
    console.log("\nAvailable actions:");
    plugin.actions?.forEach((action) => {
      console.log(`- ${action.name}: ${action.description}`);
    });

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
