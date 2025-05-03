import { IAgentRuntime, generateObject, ModelClass } from "@elizaos/core";
import { SignalSchema } from "./TelegramMonitorService";
import { z } from "zod";

export const EnhancedSignalSchema = z.object({
  isTradeSignal: z.boolean(),
  type: z.enum(["BUY", "SELL"]),
  confidence: z.number().min(0).max(100),
  isUpdateMessage: z.boolean(),
  pumpDetected: z.boolean(),
  pumpMultiplier: z.number().optional(),
  buySignalStrength: z.number().min(0).max(100),
  urgencyLevel: z.enum(["low", "medium", "high"]).optional(),
  reasonForBuy: z.string().optional(),
});

export type SignalExtractionType = z.infer<typeof SignalSchema>;
export type EnhancedSignalExtractionType = z.infer<typeof EnhancedSignalSchema>;

export class SentimentAnalysisService {
  constructor(private runtime: IAgentRuntime) {}

  private readonly ENHANCED_SENTIMENT_PROMPT = `
  Analyze this crypto trading signal message thoroughly. Determine if it's a new buy signal, an update on an existing position, or a potential sell signal.
  
  Message: {{text}}
  
  Return the following properties:
  - isTradeSignal: Boolean (true for actionable signals, false for informational only)
  - type: "BUY" or "SELL"
  - confidence: 0-100 based on message sentiment
  - isUpdateMessage: Boolean (true if message is updating existing position performance)
  - pumpDetected: Boolean (true if message indicates token has already pumped)
  - pumpMultiplier: Number (how many X the token has already pumped, e.g. 2 for 2x)
  - buySignalStrength: 0-100 (strength of buy recommendation regardless of pump status)
  - urgencyLevel: "low", "medium", or "high" (how urgent the action is)
  - reasonForBuy: Brief explanation of why this should or shouldn't be bought

  Important BUY patterns to detect:
  1. New listings or launches (high urgency, strong buy if caught early)
  2. Phrases like "still early" or "still low cap" (positive buy signals despite some movement)
  3. Mentions of target prices or expected movement (indicates potential remains)
  4. Messages with strong buying sentiment despite some price increase

  Important SELL patterns to detect:
  1. Update messages reporting 5x or higher gains (indicates potential top)
  2. Messages containing phrases like "take profits" or "secure gains"
  3. Updates showing extreme volatility or rapid price increase (may indicate pump and dump)
  4. Messages that mention "XX" with high multipliers (5x, 10x, etc.)
  5. Phrases indicating momentum is slowing like "starting to stabilize" or "consolidating"

  For already pumped tokens:
  - If token has pumped 1-2x but sentiment is very bullish (95+ confidence), consider it a buy
  - If token has pumped 3-4x with continued strong sentiment, it could still be a buy but with caution
  - If token has pumped 5x or more, consider it a potential SELL signal if we already hold it
  - If message specifically mentions "moon" or "parabolic" with high multiples, consider it a SELL signal
  `;

  private readonly BASIC_SENTIMENT_PROMPT = `
  Analyze this crypto trading signal message. Focus only on sentiment indicators and metrics.
  
  Message: {{text}}
  
  Return:
  - type: "BUY"
  - isTradeSignal: true
  - confidence: 0-100 based on:
    - Price movement (24h)
    - Volume metrics
    - Buy/Sell ratio
    - Market cap and liquidity
    - Holder metrics`;

  async analyzeSentiment(text: string): Promise<SignalExtractionType | null> {
    try {
      // First try the enhanced analysis to get detailed insights
      const enhancedResult = await this.analyzeEnhancedSentiment(text);
      
      if (enhancedResult) {
        // Convert the enhanced result to the basic format expected by the current system
        const basicResult: SignalExtractionType = {
          isTradeSignal: this.shouldBeTradedSignal(enhancedResult),
          type: enhancedResult.type,
          confidence: enhancedResult.confidence
        };
        
        return basicResult;
      }
      
      // Fallback to basic analysis if enhanced fails
      const obj = await generateObject({
        runtime: this.runtime,
        context: this.BASIC_SENTIMENT_PROMPT.replace("{{text}}", text),
        modelClass: ModelClass.LARGE,
        schema: SignalSchema,
        mode: "auto",
      });

      return obj?.object as SignalExtractionType;
    } catch (error) {
      console.error("Sentiment analysis error:", error);
      return null;
    }
  }
  
  async analyzeEnhancedSentiment(text: string): Promise<EnhancedSignalExtractionType | null> {
    try {
      const obj = await generateObject({
        runtime: this.runtime,
        context: this.ENHANCED_SENTIMENT_PROMPT.replace("{{text}}", text),
        modelClass: ModelClass.LARGE,
        schema: EnhancedSignalSchema,
        mode: "auto",
      });

      return obj?.object as EnhancedSignalExtractionType;
    } catch (error) {
      console.error("Enhanced sentiment analysis error:", error);
      return null;
    }
  }
  
  private shouldBeTradedSignal(enhancedSignal: EnhancedSignalExtractionType): boolean {
    // We want to consider all BUY signals as valid trade signals
    // Only filtering out messages that are explicitly not trade signals
    
    // If it's explicitly marked as not a trade signal by the model, respect that
    if (enhancedSignal.isTradeSignal === false) return false;
    
    // For SELL signals, we'll act on them only if we have a position
    if (enhancedSignal.type === "SELL") return true;
    
    // For BUY signals, always treat them as trade signals
    if (enhancedSignal.type === "BUY") return true;
    
    // Default - shouldn't normally reach here
    console.log("⚠️ Unusual signal type detected, defaulting to tradeable");
    return true;
  }
}

export const createSentimentAnalysisService = (
  runtime: IAgentRuntime
): SentimentAnalysisService => new SentimentAnalysisService(runtime);
