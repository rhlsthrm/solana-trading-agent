// src/actions/executeSignalTrade.ts
import { Action, IAgentRuntime, Memory, ServiceType } from "@ai16z/eliza";
import { SignalTradeProcessor } from "../processors/SignalTradeProcessor";
import { createJupiterService } from "../services/jupiter";
import Database from "better-sqlite3";
import { TradingContextService } from "../services/TradingContext";
import { parseSignalWithClaude } from "../utils/parseSignalWithClaude";

const executeSignalTradeAction: Action = {
  name: "EXECUTE_SIGNAL_TRADE",
  similes: ["PROCESS_SIGNAL", "TRADE_SIGNAL"],
  description: "Execute a trade based on a DegenSeals signal",

  validate: async (runtime: IAgentRuntime, message: Memory) => {
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory
  ): Promise<boolean> => {
    try {
      console.log("Processing trade signal:", message.content.text);

      // Get trading context
      const tradingContext = runtime.getService<TradingContextService>(
        ServiceType.TEXT_GENERATION
      );
      if (!tradingContext) {
        console.error("Trading context not found");
        return false;
      }

      // Parse signal from message
      const signal = await parseSignalWithClaude(message.content.text);
      if (!signal) {
        console.log("No valid signal found in message");
        return false;
      }

      // Initialize services
      const jupiterService = createJupiterService({
        minLiquidity: Number(runtime.getSetting("MIN_LIQUIDITY") || "50000"),
        minVolume24h: Number(runtime.getSetting("MIN_VOLUME_24H") || "10000"),
      });

      const db = new Database("trading.db");

      // Create trade processor
      const processor = new SignalTradeProcessor(
        jupiterService,
        db,
        {
          minLiquidity: Number(runtime.getSetting("MIN_LIQUIDITY") || "50000"),
          minVolume24h: Number(runtime.getSetting("MIN_VOLUME_24H") || "10000"),
          maxPositionSizePercent: Number(
            runtime.getSetting("MAX_POSITION_SIZE_PERCENT") || "1"
          ),
          stopLossPercent: Number(
            runtime.getSetting("STOP_LOSS_PERCENT") || "10"
          ),
          maxSlippagePercent: Number(
            runtime.getSetting("MAX_SLIPPAGE_PERCENT") || "2"
          ),
          maxDrawdownPercent: Number(
            runtime.getSetting("MAX_DRAWDOWN_PERCENT") || "20"
          ),
        },
        tradingContext.walletClient
      );

      // Step 1: Validate signal
      console.log("Validating signal...");
      const validationResult = await processor.validateSignal(signal);
      if (!validationResult.isValid) {
        console.log("Signal validation failed:", validationResult.reason);
        return false;
      }

      // Step 2: Calculate position size
      console.log("Calculating position size...");
      const positionSize = await processor.calculatePositionSize(
        signal.tokenAddress,
        validationResult.tokenInfo!.price,
        signal.riskLevel
      );

      // Step 3: Execute trade
      console.log("Executing trade...");
      const tradeResult = await processor.executeTrade(signal, positionSize);

      if (!tradeResult.success) {
        console.error("Trade execution failed:", tradeResult.error);
        return false;
      }

      // Log success
      console.log("Trade executed successfully!", {
        txId: tradeResult.txId,
        entryPrice: tradeResult.entryPrice,
        positionSize: tradeResult.positionSize,
      });

      return true;
    } catch (error) {
      console.error("Error in EXECUTE_SIGNAL_TRADE:", error);
      return false;
    }
  },

  examples: [
    [
      {
        user: "telegram",
        content: {
          text: "🚨 NEW SIGNAL 🚨\nToken: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v\nBuy at: $1.25\nRisk: MEDIUM",
        },
      },
      {
        user: "agent",
        content: {
          text: "Processing trade signal for EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          action: "EXECUTE_SIGNAL_TRADE",
        },
      },
    ],
  ],
};

export default executeSignalTradeAction;
