import { IAgentRuntime, ModelClass } from "@ai16z/eliza";
import { generateObject } from "@ai16z/eliza";
import { z } from "zod";
import { generateId } from "./uuid";
import { ProficyService } from "../services/ProficyService";

export const SignalSchema = z.object({
  type: z.enum(["BUY", "SELL"]),
  confidence: z.number().min(0).max(100).optional(),
  isTradeSignal: z.boolean(),
});

export type SignalExtractionType = z.infer<typeof SignalSchema>;

export interface EnhancedSignal extends SignalExtractionType {
  id: string;
  tokenAddress: string;
  price?: number;
  marketCap?: number;
  liquidity?: number;
  volume24h?: number;
}

const SIGNAL_EXTRACTION_PROMPT = `
You are an expert crypto trading signal analyzer. Extract key information from this message.
Determine if it's a trading signal (mentioning buy/sell of a token) and if so, analyze:
1. Type (BUY or SELL)
2. Confidence level (0-100) based on the certainty and enthusiasm in the message

Message:
{{text}}

Return only these key points, no extra information needed.`;

export async function parseSignalWithClaude(
  text: string,
  runtime: IAgentRuntime,
  proficyService: ProficyService,
  idGenerator = generateId
): Promise<EnhancedSignal | null> {
  try {
    const tokenInfo = await proficyService.getTokenInfo(text);
    console.log("tokenInfo", tokenInfo);

    if (!tokenInfo?.isValid) {
      console.log("No valid token found in message");
      return null;
    }

    const result = await generateObject({
      runtime,
      context: SIGNAL_EXTRACTION_PROMPT.replace("{{text}}", text),
      modelClass: ModelClass.LARGE,
      schema: SignalSchema,
      mode: "auto",
    });

    const extractedData = result.object as SignalExtractionType;

    // Only proceed if it's a valid trade signal
    if (!extractedData.isTradeSignal) {
      return null;
    }

    // Combine token info with signal data
    const signal: EnhancedSignal = {
      id: idGenerator(),
      tokenAddress: tokenInfo.address,
      type: extractedData.type,
      confidence: extractedData.confidence || 50, // Default 50% if not specified
      isTradeSignal: true,
      price: tokenInfo.price,
      marketCap: tokenInfo.marketCap,
      liquidity: tokenInfo.liquidity,
      volume24h: tokenInfo.volume24h,
    };

    return signal;
  } catch (error) {
    console.error("Error in parseSignalWithClaude:", error);
    return null;
  }
}
