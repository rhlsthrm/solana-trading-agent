import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { TokenInfo } from "../types/trade";
import { ProficyParser } from "./ProficyParser";
import { IAgentRuntime } from "@ai16z/eliza";

export class ProficyService {
  private client: TelegramClient;
  private readonly PROFICY_BOT_USERNAME = "ProficyPriceBot";
  private readonly TOKEN_ADDRESS_REGEX = /\b[A-Za-z0-9]{32,44}\b/g;
  private parser: ProficyParser;

  constructor(
    private config: {
      apiId: number;
      apiHash: string;
      sessionStr?: string;
      runtime: IAgentRuntime;
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
    this.parser = new ProficyParser(config.runtime);
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
      console.log(`Getting token info for: ${addressOrPool}`);

      // Get response from Proficy bot
      const result = await this.client.sendMessage(this.PROFICY_BOT_USERNAME, {
        message: addressOrPool,
      });

      const response = await this.waitForBotResponse(result.id);
      if (!response) {
        console.log("No response from Proficy bot");
        return null;
      }

      console.log(`Received Proficy response:\n${response.text}`);

      // Use the parser
      const parsedInfo = await this.parser.parseResponse(response.text);
      console.log("Parsed Info:", parsedInfo);

      if (!parsedInfo || !parsedInfo.isValid) {
        console.log("Failed to parse Proficy response - No valid token found");
        return null;
      }

      console.log(
        `Successfully parsed token: ${parsedInfo.name} (${parsedInfo.symbol}) at ${parsedInfo.solanaAddress}`
      );

      // Convert to TokenInfo format
      return {
        address: parsedInfo.solanaAddress,
        symbol: parsedInfo.symbol,
        name: parsedInfo.name,
        price: parsedInfo.price,
        decimals: 6, // Default to 6 decimals for SPL tokens
        liquidity: parsedInfo.liquidity,
        volume24h: parsedInfo.volume24h,
        marketCap: parsedInfo.marketCap,
        holders: parsedInfo.holders,
        isValid: true,
      };
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
}

export const createProficyService = (config: {
  apiId: number;
  apiHash: string;
  sessionStr?: string;
  runtime: IAgentRuntime;
}) => {
  return new ProficyService(config);
};
