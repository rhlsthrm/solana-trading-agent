// src/index.ts
import type { IAgentRuntime, Memory, Plugin, State } from "@ai16z/eliza";
import { solana } from "@goat-sdk/wallet-solana";
import { Connection, Keypair } from "@solana/web3.js";
import Database from "better-sqlite3";
import { createKeypairFromSecret } from "./utils/solana";
import { createJupiterService } from "./services/jupiter";
import { createTechnicalAnalysisService } from "./services/technical-analysis";

// Initialize database
function initializeDatabase() {
  const db = new Database("trading.db");

  const schema = `
    CREATE TABLE IF NOT EXISTS tokens (
      address TEXT PRIMARY KEY,
      symbol TEXT,
      liquidity NUMERIC,
      volume_24h NUMERIC,
      last_updated TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_address TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      rsi NUMERIC,
      short_ma NUMERIC,
      long_ma NUMERIC,
      volume_ma NUMERIC,
      timestamp TIMESTAMP,
      FOREIGN KEY (token_address) REFERENCES tokens(address)
    );

    CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY,
      source TEXT,
      token_address TEXT,
      signal_type TEXT,
      price NUMERIC,
      timestamp TIMESTAMP,
      processed BOOLEAN
    );

    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      token_address TEXT,
      entry_price NUMERIC,
      exit_price NUMERIC,
      position_size NUMERIC,
      signal_id TEXT,
      entry_time TIMESTAMP,
      exit_time TIMESTAMP,
      profit_loss NUMERIC,
      status TEXT
    );
  `;

  db.exec(schema);
  return db;
}

// Get wallet client
function getWalletClient(getSetting: (key: string) => string | undefined) {
  const privateKeyStr = getSetting("SOLANA_PRIVATE_KEY");
  if (!privateKeyStr) {
    throw new Error("SOLANA_PRIVATE_KEY not configured");
  }

  const rpcUrl = getSetting("SOLANA_RPC_URL");
  if (!rpcUrl) {
    throw new Error("SOLANA_RPC_URL not configured");
  }

  try {
    // Create keypair from secret
    const keypair = createKeypairFromSecret(privateKeyStr);
    console.log(`Wallet public key: ${keypair.publicKey.toString()}`);

    // Create Solana connection
    const connection = new Connection(rpcUrl, "confirmed");

    // Return both wallet client and connection
    return {
      walletClient: solana({
        keypair,
        connection,
      }),
      connection,
    };
  } catch (error) {
    throw new Error(
      `Failed to initialize wallet: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
  }
}

function getWalletProvider(walletClient: any) {
  return {
    async get(
      runtime: IAgentRuntime,
      message: Memory,
      state?: State
    ): Promise<string | null> {
      try {
        const address = walletClient.getAddress();
        const balance = await walletClient.balanceOf(address);

        // Debug log to see what we're getting
        console.log("Raw balance:", balance);

        // Handle balance properly based on its type
        let solBalance: string;
        if (balance && typeof balance === "object" && "toString" in balance) {
          // If it's a BN or similar object with toString()
          solBalance = (Number(balance.toString()) / 1e9).toFixed(4);
        } else if (typeof balance === "number") {
          solBalance = (balance / 1e9).toFixed(4);
        } else {
          solBalance = "Unknown";
          console.error("Unexpected balance type:", typeof balance);
        }

        return `Solana Wallet Address: ${address}\nBalance: ${solBalance} SOL`;
      } catch (error) {
        console.error("Error in Solana wallet provider:", error);
        return null;
      }
    },
  };
}

// Main plugin creation function
async function createTradingPlugin(
  getSetting: (key: string) => string | undefined
): Promise<Plugin> {
  // Initialize Config
  const config = {
    timeframes: ["5m", "15m", "1h"],
    rsiPeriod: 14,
    rsiOverbought: 70,
    rsiOversold: 30,
    maShort: 20,
    maLong: 50,
    minVolume24h: Number(getSetting("MIN_VOLUME_24H") || "10000"),
    maxDrawdownPercent: 20,
    minLiquidity: Number(getSetting("MIN_LIQUIDITY") || "50000"),
    maxPositionSizePercent: Number(
      getSetting("MAX_POSITION_SIZE_PERCENT") || "1"
    ),
    stopLossPercent: Number(getSetting("STOP_LOSS_PERCENT") || "10"),
    maxSlippagePercent: Number(getSetting("MAX_SLIPPAGE_PERCENT") || "2"),
  };

  // Initialize database
  const db = initializeDatabase();

  // Initialize wallet
  const { walletClient, connection } = getWalletClient(getSetting);
  if (!walletClient) {
    throw new Error("Failed to initialize wallet client");
  }

  // Initialize Jupiter service
  const jupiterService = createJupiterService({
    minLiquidity: config.minLiquidity,
    minVolume24h: config.minVolume24h,
  });

  const technicalAnalysis = createTechnicalAnalysisService(
    connection,
    config.timeframes
  );

  // Create ELIZA plugin structure
  return {
    name: "[GOAT] Solana Trading Agent",
    description: "Automated trading agent for Solana tokens",
    providers: [getWalletProvider(walletClient)],
    evaluators: [],
    services: [],
    actions: [
      {
        name: "SCAN_TOKENS",
        similes: ["CHECK_TOKENS", "FIND_TOKENS"],
        description: "Scan for tradeable tokens meeting criteria",
        handler: async (runtime, message) => {
          try {
            console.log("Starting token scan...");

            // Fetch tradeable tokens from Jupiter
            // Only fetch top 100 tokens to avoid rate limits
            const tokens = await jupiterService.fetchTradeableTokens(100);

            // Prepare statement for efficient insertion
            const stmt = db.prepare(`
                INSERT OR REPLACE INTO tokens 
                (address, symbol, liquidity, volume_24h, last_updated)
                VALUES (?, ?, ?, ?, datetime('now'))
              `);

            // Begin transaction
            db.transaction(() => {
              for (const token of tokens) {
                stmt.run(
                  token.address,
                  token.symbol,
                  token.liquidity,
                  token.volume24h
                );
              }
            })();

            console.log(
              `Successfully saved ${tokens.length} tokens to database`
            );
            return true;
          } catch (error) {
            console.error("Error in SCAN_TOKENS:", error);
            return false;
          }
        },
        validate: async () => true,
        examples: [
          [
            {
              user: "user1",
              content: { text: "Scan for tradeable tokens" },
            },
            {
              user: "agent",
              content: {
                text: "Scanning for tokens meeting liquidity and volume criteria",
                action: "SCAN_TOKENS",
              },
            },
          ],
        ],
      },
      {
        name: "ANALYZE_TOKEN",
        similes: ["CHECK_TOKEN", "ANALYZE"],
        description: "Perform technical analysis on a specific token",
        handler: async (runtime, message) => {
          try {
            // Extract token address from message
            const match = message.content.text.match(
              /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/
            );
            if (!match) {
              console.log("No valid token address found in message");
              return false;
            }

            const tokenAddress = match[0];
            console.log(`Analyzing token: ${tokenAddress}`);

            // Get token info from database
            const token = db
              .prepare("SELECT * FROM tokens WHERE address = ?")
              .get(tokenAddress);

            if (!token) {
              console.log("Token not found in database");
              return false;
            }

            // Perform technical analysis
            const analysis = await technicalAnalysis.analyzeToken(tokenAddress);

            // Store analysis results
            const stmt = db.prepare(`
              INSERT INTO analysis (
                token_address,
                timeframe,
                rsi,
                short_ma,
                long_ma,
                volume_ma,
                timestamp
              ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
            `);

            // Store results for each timeframe
            for (const [timeframe, indicators] of Object.entries(analysis)) {
              if (indicators) {
                stmt.run(
                  tokenAddress,
                  timeframe,
                  indicators.rsi,
                  indicators.shortMA,
                  indicators.longMA,
                  indicators.volumeMA
                );
              }
            }

            console.log(`Analysis completed for ${token.symbol}`);
            return true;
          } catch (error) {
            console.error("Error in ANALYZE_TOKEN:", error);
            return false;
          }
        },
        validate: async () => true,
        examples: [
          [
            {
              user: "user1",
              content: {
                text: "Analyze token EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
              },
            },
            {
              user: "agent",
              content: {
                text: "Analyzing technical indicators for the specified token",
                action: "ANALYZE_TOKEN",
              },
            },
          ],
        ],
      },
      {
        name: "EXECUTE_TRADE",
        similes: ["TRADE", "PLACE_TRADE"],
        description: "Execute a trade based on signal",
        handler: async (runtime, message) => {
          // Implementation will be added next
          return true;
        },
        validate: async () => true,
        examples: [],
      },
    ],
  };
}

export default createTradingPlugin;
