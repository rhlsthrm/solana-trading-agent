import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { TokenInfo } from "../types/trade";

export class ProficyService {
  private client: TelegramClient;
  private readonly PROFICY_BOT_USERNAME = "ProficyPriceBot";
  private readonly TOKEN_ADDRESS_REGEX = /\b[A-Za-z0-9]{32,44}\b/g;

  constructor(
    private config: {
      apiId: number;
      apiHash: string;
      sessionStr?: string;
    }
  ) {
    const stringSession = new StringSession(config.sessionStr || "");
    this.client = new TelegramClient(
      stringSession,
      config.apiId,
      config.apiHash,
      {
        connectionRetries: 5,
      }
    );
  }

  async init() {
    await this.client.start({
      phoneNumber: async () => "", // We don't need this for bot interactions
      password: async () => "", // We don't need this for bot interactions
      phoneCode: async () => "", // We don't need this for bot interactions
      onError: (err) => console.error("Proficy client error:", err),
    });
  }

  async getTokenInfo(addressOrPool: string): Promise<TokenInfo | null> {
    try {
      // Send query to Proficy bot
      const result = await this.client.sendMessage(this.PROFICY_BOT_USERNAME, {
        message: addressOrPool,
      });

      // Wait for response
      const response = await this.waitForBotResponse(result.id);
      if (!response) {
        console.log("No response from Proficy bot");
        return null;
      }

      // Parse the response
      return this.parseTokenInfo(response.text);
    } catch (error) {
      console.error("Error getting token info from Proficy:", error);
      return null;
    }
  }

  private async waitForBotResponse(
    messageId: number,
    timeout = 10000
  ): Promise<any | null> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        // Get responses after our message
        const messages = await this.client.getMessages(
          this.PROFICY_BOT_USERNAME,
          {
            limit: 1,
            offsetId: messageId,
          }
        );

        if (messages && messages.length > 0) {
          return messages[0];
        }

        // Wait before checking again
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error) {
        console.error("Error waiting for bot response:", error);
        return null;
      }
    }

    console.log("Timeout waiting for Proficy bot response");
    return null;
  }

  private parseTokenInfo(response: string): TokenInfo | null {
    try {
      // Updated regex to find token addresses whether they're in backticks or not
      const addresses =
        response.match(/(?:`|^|\s)([A-Za-z0-9]{32,44})(?:`|$|\s)/) || [];
      const tokenAddress = addresses[1] || "";

      if (!tokenAddress) {
        console.log("No token address found in response");
        return null;
      }

      // Extract token name and symbol from the first line
      // Format: **Swarms (swarms)**
      const nameSymbolMatch = response.match(
        /\*\*([\w\s/]+)\s*\(([\w]+)\)\*\*/
      );
      const name = nameSymbolMatch?.[1]?.trim() || "";
      const symbol = nameSymbolMatch?.[2] || "";

      // Extract price - Format: SOL $0.2861
      const priceMatch = response.match(/SOL\s*\$(\d+\.?\d*)/);
      const price = priceMatch ? parseFloat(priceMatch[1]) : 0;

      // Extract market cap - Format: **MC:** 286M
      const mcMatch = response.match(/\*\*MC:\*\*\s*(\d+\.?\d*[KMB]?)/);
      const marketCap = mcMatch
        ? this.parseNumberWithSuffix(mcMatch[1])
        : undefined;

      // Extract liquidity - Format: **Liq:** 5.67M
      const liqMatch = response.match(/\*\*Liq:\*\*\s*(\d+\.?\d*[KMB]?)/);
      const liquidity = liqMatch
        ? this.parseNumberWithSuffix(liqMatch[1])
        : undefined;

      // Extract volume - Updated regex for total volume
      const volMatch = response.match(/1D:.*?\$(\d+\.?\d*[KMB]?)/);
      const volume24h = volMatch
        ? this.parseNumberWithSuffix(volMatch[1])
        : undefined;

      // Extract holders - Format: **Holders:** 19K
      const holdersMatch = response.match(
        /\*\*Holders:\*\*\s*(\d+\.?\d*[KMB]?)/
      );
      const holders = holdersMatch
        ? this.parseNumberWithSuffix(holdersMatch[1])
        : undefined;

      return {
        address: tokenAddress,
        symbol,
        name,
        price,
        marketCap,
        liquidity,
        volume24h,
        holders,
        isValid: true,
      };
    } catch (error) {
      console.error("Error parsing Proficy response:", error);
      return null;
    }
  }

  private parseNumberWithSuffix(value: string): number {
    const suffixMultiplier = {
      K: 1000,
      M: 1000000,
      B: 1000000000,
    };

    const match = value.match(/^(\d+\.?\d*)([KMB])?$/);
    if (!match) return 0;

    const number = parseFloat(match[1]);
    const suffix = match[2];

    return suffix
      ? number * suffixMultiplier[suffix as keyof typeof suffixMultiplier]
      : number;
  }
}

export const createProficyService = (config: {
  apiId: number;
  apiHash: string;
  sessionStr?: string;
}) => {
  return new ProficyService(config);
};
