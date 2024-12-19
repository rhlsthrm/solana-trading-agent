// src/services/jupiter.ts
interface JupiterToken {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  logoURI?: string;
  tags: string[];
  daily_volume: number;
  created_at: string;
  freeze_authority: string | null;
  mint_authority: string | null;
  extensions: {
    coingeckoId?: string;
  };
}

interface TokenInfo {
  address: string;
  symbol: string;
  liquidity: number;
  volume24h: number;
}

export class JupiterService {
  private readonly TOKENS_API = "https://tokens.jup.ag/";
  private readonly PRICE_API = "https://api.jup.ag/price/v2";
  private readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
  private tokenCache: { data: JupiterToken[] | null; timestamp: number } = {
    data: null,
    timestamp: 0,
  };

  constructor(
    private config: {
      minLiquidity: number;
      minVolume24h: number;
    }
  ) {}

  private async fetchWithRetry(url: string, retries = 3): Promise<any> {
    let lastError;

    for (let i = 0; i < retries; i++) {
      try {
        const response = await fetch(url, {
          headers: {
            Referer: "https://jup.ag", // Required by API
            Origin: "https://jup.ag", // Required by API
          },
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.json();
      } catch (error) {
        lastError = error;
        if (i < retries - 1) {
          // Exponential backoff
          await new Promise((resolve) =>
            setTimeout(resolve, Math.pow(2, i) * 1000)
          );
        }
      }
    }

    throw lastError;
  }

  private async getVerifiedTokens(): Promise<JupiterToken[]> {
    const now = Date.now();
    if (
      this.tokenCache.data &&
      now - this.tokenCache.timestamp < this.CACHE_DURATION
    ) {
      return this.tokenCache.data;
    }

    console.log("Fetching verified tokens from Jupiter...");
    const response = await this.fetchWithRetry(
      `${this.TOKENS_API}tokens?tags=verified`
    );

    this.tokenCache = {
      data: response,
      timestamp: now,
    };

    return this.tokenCache.data;
  }

  public async fetchTradeableTokens(limit: number = 100): Promise<TokenInfo[]> {
    try {
      console.log("Fetching tradeable tokens from Jupiter...");

      // Get verified tokens first
      const tokens = await this.getVerifiedTokens();
      console.log(`Found ${tokens.length} verified tokens`);

      // Filter and sort by daily volume
      const tradeableTokens = tokens
        .filter(
          (token) =>
            // Filter out tokens with insufficient volume
            token.daily_volume >= this.config.minVolume24h
        )
        .sort((a, b) => b.daily_volume - a.daily_volume) // Sort by volume DESC
        .slice(0, Math.min(tokens.length, limit)) // Take top N tokens
        .map((token) => ({
          address: token.address,
          symbol: token.symbol,
          liquidity: 0, // We'll get this from price API if needed
          volume24h: token.daily_volume,
        }));

      console.log(
        `Found ${tradeableTokens.length} tradeable tokens meeting criteria`
      );
      return tradeableTokens;
    } catch (error) {
      console.error("Error fetching tradeable tokens:", error);
      throw error;
    }
  }

  public async getTokenPrice(tokenAddress: string): Promise<number | null> {
    try {
      const response = await this.fetchWithRetry(
        `${this.PRICE_API}?ids=${tokenAddress}`
      );

      return response?.data?.[tokenAddress]?.price || null;
    } catch (error) {
      console.error(`Error fetching price for token ${tokenAddress}:`, error);
      return null;
    }
  }
}

export const createJupiterService = (config: {
  minLiquidity: number;
  minVolume24h: number;
}) => {
  return new JupiterService(config);
};
