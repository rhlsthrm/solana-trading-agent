import { z } from "zod";
import { generateObject, ModelClass, IAgentRuntime } from "@ai16z/eliza";

// Schema for Proficy response
export const ProficyResponseSchema = z.object({
  name: z.string(),
  symbol: z.string(),
  price: z.number(),
  volume24h: z.number(),
  marketCap: z.number(),
  liquidity: z.number(),
  holders: z.number(),
  solanaAddress: z.string(),
  isValid: z.boolean(),
});

export type ProficyResponseType = z.infer<typeof ProficyResponseSchema>;

const PROFICY_PROMPT = `
Extract token information from this Proficy bot response.
Focus on finding the correct Solana address, which appears alone on a line not marked as "PROMO".
Any address in the "PROMO" section should be ignored.
The response follows a standard format like this:

**TOKEN (SYMBOL)** SOL $PRICE
... market data ...
**MC:** MCAP | **Liq:** LIQUIDITY
... other data ...
SOLANA_ADDRESS
... holders data ...

Response text:
{{text}}

Return the token information in the specified format.
`;

export class ProficyParser {
  constructor(private runtime: IAgentRuntime) {}

  async parseResponse(text: string): Promise<ProficyResponseType | null> {
    try {
      const result = await generateObject({
        runtime: this.runtime,
        context: PROFICY_PROMPT.replace("{{text}}", text),
        modelClass: ModelClass.LARGE,
        schema: ProficyResponseSchema,
        mode: "auto",
      });

      return result.object as ProficyResponseType;
    } catch (error) {
      console.error("Error parsing Proficy response:", error);
      return null;
    }
  }
}
