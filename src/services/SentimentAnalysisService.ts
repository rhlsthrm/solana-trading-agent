import { IAgentRuntime, generateObject, ModelClass } from "@elizaos/core";
import { SignalSchema } from "./TelegramMonitorService";
import { z } from "zod";

export type SignalExtractionType = z.infer<typeof SignalSchema>;

export class SentimentAnalysisService {
  constructor(private runtime: IAgentRuntime) {}

  private readonly SENTIMENT_PROMPT = `
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
      const obj = await generateObject({
        runtime: this.runtime,
        context: this.SENTIMENT_PROMPT.replace("{{text}}", text),
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
}

export const createSentimentAnalysisService = (
  runtime: IAgentRuntime
): SentimentAnalysisService => new SentimentAnalysisService(runtime);
