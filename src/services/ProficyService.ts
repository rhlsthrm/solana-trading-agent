import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { TokenInfo } from "../types/trade";
import { ProficyParser } from "./ProficyParser";
import { IAgentRuntime } from "@elizaos/core";
import Database from "better-sqlite3";

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
      db: Database.Database;
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


      // Use the parser
      const parsedInfo = await this.parser.parseResponse(response.text);

      if (!parsedInfo || !parsedInfo.isValid) {
        console.log("Failed to parse Proficy response - No valid token found");
        return null;
      }

      console.log(
        `Successfully parsed token: ${parsedInfo}`
      );


      // Convert to TokenInfo format
      return {
        address: parsedInfo.solanaAddress,
        symbol: parsedInfo.symbol,
        name: parsedInfo.name,
        price: parsedInfo.price,
        decimals: 9,
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
    timeout = 30000 // Maximum 30 seconds wait time
  ): Promise<any | null> {
    const startTime = Date.now();

    // Initial wait to give bot time to start processing
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Keep trying until timeout
    while (Date.now() - startTime < timeout) {
      try {
        // Get the most recent message from the bot
        const messages = await this.client.getMessages(
          this.PROFICY_BOT_USERNAME,
          {
            limit: 1, // Just get the last message
          }
        );

        if (messages && messages.length > 0) {
          console.log("✅ Got Proficy bot response");
          return messages[0];
        }

        // Wait 2 seconds before trying again
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (error) {
        console.error("Error checking for bot response:", error);
        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    console.log(
      `⏱️ Timed out after ${timeout / 1000}s waiting for Proficy bot response`
    );
    return null;
  }
}

export const createProficyService = (config: {
  apiId: number;
  apiHash: string;
  sessionStr?: string;
  runtime: IAgentRuntime;
  db: Database.Database;
}) => {
  return new ProficyService(config);
};
