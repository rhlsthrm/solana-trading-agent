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
Focus on finding the token name, symbol, price, market cap, liquidity, and Solana address.
The Solana address is a 32-44 character string that appears alone on a line (might be near "Renounced" or "Holders" text).
Ignore any addresses in "PROMO" sections.

The response follows formats like:

Example 1:
TokenName (SYMBOL) SOL $PRICE
... Price/Volume/B/S data ...
MC: $XXM | Liq: $YYM
... other data ...
SOLANA_ADDRESS
... other info ...

Example 2:
TokenName (SYMBOL) SOL $PRICE
... Price/Volume/B/S data ...
MC: XXM | Liq: YYM (ZZ% 🔥)
... other data ...
Chart: /c_XXXX | Map: /b_YYYY
... other links ...
SOLANA_ADDRESS
Renounced, Mint (off/on), Freezable (off/on)
... other info ...

Response text:
{{text}}

Extract the name, symbol, price, liquidity, market cap, any holder info, and most importantly the Solana address.
Be sure to handle different formatting variations and extract numbers correctly.
If the Solana address is not found, mark isValid as false.
Return the information in the specified format.
`;

export class ProficyParser {
  // This regex matches Solana token addresses (exclude addresses inside URLs)
  private readonly SOLANA_ADDRESS_REGEX = /(?<!\/)([1-9A-HJ-NP-Za-km-z]{32,44})(?!\/)/g;
  
  constructor(private runtime: IAgentRuntime) {}

  async parseResponse(text: string): Promise<ProficyResponseType | null> {
    try {
      // First try with AI parsing
      const result = await generateObject({
        runtime: this.runtime,
        context: PROFICY_PROMPT.replace("{{text}}", text),
        modelClass: ModelClass.LARGE,
        schema: ProficyResponseSchema,
        mode: "auto",
      });

      const parsedResult = result.object as ProficyResponseType;
      
      // If AI parser found a valid address, return it
      if (parsedResult && parsedResult.isValid && this.isValidSolanaAddress(parsedResult.solanaAddress)) {
        return parsedResult;
      }
      
      // If AI parsing failed or didn't find a valid address, try regex fallback
      return this.fallbackParse(text);
    } catch (error) {
      console.error("Error parsing Proficy response:", error);
      // Try fallback parsing if AI parsing fails
      return this.fallbackParse(text);
    }
  }
  
  private isValidSolanaAddress(address: string): boolean {
    // Basic validation for Solana addresses
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  }
  
  private fallbackParse(text: string): ProficyResponseType | null {
    try {
      console.log("Using fallback parser for Proficy response");
      
      // Extract token name and symbol from the first line
      const firstLine = text.split('\n')[0].trim();
      const nameSymbolMatch = firstLine.match(/^([^(]+)\s*\(([^)]+)\)/);
      
      const name = nameSymbolMatch ? nameSymbolMatch[1].trim() : "Unknown";
      const symbol = nameSymbolMatch ? nameSymbolMatch[2].trim() : "Unknown";
      
      // Extract price
      const priceMatch = text.match(/SOL\s*\$([0-9,.]+)/);
      const price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : 0;
      
      // Extract market cap and liquidity - handling variations including $ and whitespace
      const mcMatch = text.match(/MC:?\s*\$?\s*([0-9.]+)\s*([KMB])/i);
      const marketCap = mcMatch ? this.parseMetric(mcMatch[1], mcMatch[2]) : 0;
      
      // Also try alternate format: MC: 1.12B
      const mcAltMatch = !mcMatch ? text.match(/MC:?\s*\$?\s*([0-9.]+)\s*([KMB])/i) : null;
      const marketCapAlt = mcAltMatch ? this.parseMetric(mcAltMatch[1], mcAltMatch[2]) : 0;
      
      const liqMatch = text.match(/Liq:?\s*\$?\s*([0-9.]+)\s*([KMB])/i);
      const liquidity = liqMatch ? this.parseMetric(liqMatch[1], liqMatch[2]) : 0;
      
      // Extract holders (if available)
      const holdersMatch = text.match(/Holders:\s*([0-9,]+)/i);
      const holders = holdersMatch ? parseInt(holdersMatch[1].replace(/,/g, '')) : 0;
      
      // Extract volume
      const volMatch = text.match(/1D:[^$]*\$([0-9.]+)([KMB])/i);
      const volume24h = volMatch ? this.parseMetric(volMatch[1], volMatch[2]) : 0;
      
      // Find token address by regex
      // Look for lines with only an address (not in PROMO section)
      const lines = text.split('\n');
      let solanaAddress = "UNKNOWN";
      let isValid = false;
      
      for (const line of lines) {
        const trimmedLine = line.trim();
        // Skip PROMO section
        if (trimmedLine.includes("PROMO:")) break;
        
        // Check if the line contains only a Solana address
        const addressMatches = [...trimmedLine.matchAll(this.SOLANA_ADDRESS_REGEX)];
        if (addressMatches.length === 1 && trimmedLine.length < 50) {
          solanaAddress = addressMatches[0][0];
          isValid = true;
          break;
        }
      }
      
      // Use alternate market cap value if main one is 0
      const finalMarketCap = marketCap || marketCapAlt;
      
      return {
        name,
        symbol, 
        price,
        marketCap: finalMarketCap,
        liquidity,
        volume24h,
        holders,
        solanaAddress,
        isValid
      };
    } catch (error) {
      console.error("Error in fallback parser:", error);
      return null;
    }
  }
  
  private parseMetric(value: string, unit: string): number {
    const baseValue = parseFloat(value);
    switch (unit.toUpperCase()) {
      case 'K': return baseValue * 1_000;
      case 'M': return baseValue * 1_000_000;
      case 'B': return baseValue * 1_000_000_000;
      default: return baseValue;
    }
  }
}
