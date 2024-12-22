// src/utils/parseSignalWithClaude.ts
import { IAgentRuntime, ModelClass } from "@ai16z/eliza";
import { generateObject } from "@ai16z/eliza";
import { z } from "zod";
import { generateId } from "./uuid";

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
};

export interface EnhancedSignal extends SignalExtractionType {
  id: string;
  tokenAddress: string;
  isTradeSignal: boolean;
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

    console.log("Runtime model config:", {
      provider: runtime.modelProvider,
      hasToken: !!runtime.token,
    });

    const addressPattern = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;
    const addressMatch = text.match(addressPattern);
    if (!addressMatch) {
      return null;
    }
    const tokenAddress = addressMatch[0];

    // Use generateObject to extract structured data
    const result = await generateObject({
      runtime,
      context: SIGNAL_EXTRACTION_PROMPT.replace("{{text}}", text),
      modelClass: ModelClass.SMALL,
      schema: SignalExtractionSchema,
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
    return null;
  }
}
