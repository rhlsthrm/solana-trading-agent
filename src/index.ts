// src/index.ts
import type { IAgentRuntime, Plugin } from "@ai16z/eliza";
import { createJupiterService } from "./services/jupiter";
import { createTelegramMonitorService } from "./services/telegram";
import executeSignalTradeAction from "./actions/executeSignalTradeAction";
import getWalletProvider from "./utils/getWalletProvider";
import { getWalletClient } from "./utils/getWalletClient";

// Main plugin creation function
async function createTradingPlugin(
  getSetting: (key: string) => string | undefined,
  runtime: IAgentRuntime
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

  const telegramConfig = {
    apiId: Number(getSetting("TELEGRAM_API_ID")),
    apiHash: getSetting("TELEGRAM_API_HASH") || "",
    sessionStr: getSetting("TELEGRAM_SESSION"),
    dbPath: "trading.db",
    runtime: runtime,
  };

  const telegramMonitor = createTelegramMonitorService(telegramConfig);
  await telegramMonitor.start();

  // Create ELIZA plugin structure
  return {
    name: "[GOAT] Solana Trading Agent",
    description: "Automated trading agent for Solana tokens",
    providers: [getWalletProvider(walletClient)],
    evaluators: [],
    services: [],
    actions: [executeSignalTradeAction],
  };
}

export default createTradingPlugin;
