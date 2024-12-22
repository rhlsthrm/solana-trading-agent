// src/utils/parseSignalWithClaude.ts
import { IAgentRuntime, ModelClass } from "@ai16z/eliza";
import { generateObject } from "@ai16z/eliza";
import { z } from "zod";
import { generateId } from "./uuid";
import { SignalSchema } from "../services/TelegramMonitorService";

// Define the shape of our extracted data
export type SignalExtractionType = {
  type: "BUY" | "SELL";
  price: number;
  targets?: number[];
  stopLoss?: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  timeframe?: string;
  confidence?: number;
  rationale?: string;
  sentiment?: "BULLISH" | "NEUTRAL" | "BEARISH";
  tags?: string[];
  expectedTimeHorizon?: string;
  isTradeSignal: boolean;
};

export interface EnhancedSignal extends SignalExtractionType {
  id: string;
  tokenAddress: string;
  // isTradeSignal?: boolean;
}

// Define schema for signal extraction
const SignalExtractionSchema = z.object({
  type: z.enum(["BUY", "SELL"]),
  price: z.number(),
  targets: z.array(z.number()).optional(),
  stopLoss: z.number().optional(),
  riskLevel: z.enum(["LOW", "MEDIUM", "HIGH"]),
  timeframe: z.string().optional(),
  confidence: z.number().min(0).max(100).optional(),
  rationale: z.string().optional(),
  sentiment: z.enum(["BULLISH", "NEUTRAL", "BEARISH"]).optional(),
  tags: z.array(z.string()).optional(),
  expectedTimeHorizon: z.string().optional(),
  isTradeSignal: z.literal(true),
});

const SIGNAL_EXTRACTION_PROMPT = `
You are an expert crypto trading signal analyzer. Extract structured information from the following signal message.
Include all relevant trading information like entry price, targets, stop loss, risk level, timeframe, etc.
Also analyze the overall sentiment and confidence level based on the language used.

Message:
{{text}}

Extract the key information and format it according to the schema definition.`;

export async function parseSignalWithClaude(
  text: string,
  runtime: IAgentRuntime,
  idGenerator = generateId
): Promise<EnhancedSignal | null> {
  try {
    // First extract token address using regex as it's reliable
    const addressPattern =
      /\b(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\b/;

    console.log("addressPattern", addressPattern);
    const addressMatch = text.match(addressPattern);
    console.log("addressMatch", addressMatch);
    console.log("text", text);

    if (!addressMatch) {
      return null;
    }
    const tokenAddress = addressMatch[0];

    // Add debug logging
    console.log("Attempting generateObject with runtime:", {
      modelProvider: runtime.modelProvider,
      hasToken: !!runtime.token,
      modelClass: ModelClass.LARGE, // Use LARGE instead of SMALL
    });

    // Use generateObject to extract structured data
    const result = await generateObject({
      runtime: runtime,
      context: SIGNAL_EXTRACTION_PROMPT.replace("{{text}}", text),
      modelClass: ModelClass.LARGE, // Changed from SMALL to LARGE
      schema: SignalSchema,
      mode: "auto",
    });

    const extractedData = result.object as SignalExtractionType;

    // Construct enhanced signal
    const signal: EnhancedSignal = {
      id: idGenerator(),
      tokenAddress,
      ...extractedData,
    };

    return signal;
  } catch (error) {
    console.error("Error in parseSignalWithClaude:", error);
    console.error("Error details:", {
      modelProvider: runtime.modelProvider,
      hasToken: !!runtime.token,
      modelClass: ModelClass.LARGE,
    });
    return null;
  }
}
