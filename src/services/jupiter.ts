// src/services/jupiter.ts
import { PublicKey } from "@solana/web3.js";
import { IAgentRuntime } from "@ai16z/eliza";

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
  name: string;
  decimals: number;
  liquidity: number;
  volume24h: number;
  price?: number;
  priceChange24h?: number;
  marketCap?: number;
  verified: boolean;
}

interface QuoteParams {
  inputMint: string;
  outputMint: string;
  amount: number;
  slippageBps: number;
}

interface QuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: number;
  outAmount: number;
  otherAmountThreshold: number;
  swapMode: string;
  priceImpactPct: number;
  routePlan: any[];
  contextSlot: number;
}

interface SwapResponse {
  txid: string;
  inputAmount: number;
  outputAmount: number;
}

export class JupiterService {
  private readonly TOKENS_API = "https://tokens.jup.ag/";
  private readonly PRICE_API = "https://price.jup.ag/v4";
  private readonly QUOTE_API = "https://quote-api.jup.ag/v6";
  private readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
  private tokenCache: { data: JupiterToken[] | null; timestamp: number } = {
    data: null,
    timestamp: 0,
  };
  private priceCache: Map<string, { price: number; timestamp: number }> =
    new Map();

  constructor(
    private config: {
      minLiquidity: number;
      minVolume24h: number;
    }
  ) {}

  private async fetchWithRetry(
    url: string,
    options: RequestInit = {},
    retries = 3
  ): Promise<any> {
    let lastError;
    const defaultHeaders = {
      "Content-Type": "application/json",
      Referer: "https://jup.ag",
      Origin: "https://jup.ag",
    };

    for (let i = 0; i < retries; i++) {
      try {
        const response = await fetch(url, {
          ...options,
          headers: {
            ...defaultHeaders,
            ...options.headers,
          },
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.json();
      } catch (error) {
        lastError = error;
        if (i < retries - 1) {
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

      // Get price data for all tokens
      const priceData = await this.fetchWithRetry(
        `${this.PRICE_API}/price?ids=${tokens.map((t) => t.address).join(",")}`
      );

      // Filter and sort by daily volume
      const tradeableTokens = await Promise.all(
        tokens
          .filter((token) => token.daily_volume >= this.config.minVolume24h)
          .sort((a, b) => b.daily_volume - a.daily_volume)
          .slice(0, Math.min(tokens.length, limit))
          .map(async (token) => {
            const priceInfo = priceData?.data?.[token.address];
            return {
              address: token.address,
              symbol: token.symbol,
              name: token.name,
              decimals: token.decimals,
              liquidity: priceInfo?.marketCap || 0,
              volume24h: token.daily_volume,
              price: priceInfo?.price,
              priceChange24h: priceInfo?.priceChange24h,
              marketCap: priceInfo?.marketCap,
              verified: true,
            };
          })
      );

      console.log(
        `Found ${tradeableTokens.length} tradeable tokens meeting criteria`
      );
      return tradeableTokens;
    } catch (error) {
      console.error("Error fetching tradeable tokens:", error);
      throw error;
    }
  }

  public async getTokenInfo(tokenAddress: string): Promise<TokenInfo | null> {
    try {
      // Check cache first
      const token = this.tokenCache.data?.find(
        (t) => t.address === tokenAddress
      );
      if (!token) {
        return null;
      }

      // Get price data
      const priceData = await this.fetchWithRetry(
        `${this.PRICE_API}/price?ids=${tokenAddress}`
      );

      const priceInfo = priceData?.data?.[tokenAddress];

      return {
        address: token.address,
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        liquidity: priceInfo?.marketCap || 0,
        volume24h: token.daily_volume,
        price: priceInfo?.price,
        priceChange24h: priceInfo?.priceChange24h,
        marketCap: priceInfo?.marketCap,
        verified: true,
      };
    } catch (error) {
      console.error(`Error fetching info for token ${tokenAddress}:`, error);
      return null;
    }
  }

  public async getQuote(params: QuoteParams): Promise<QuoteResponse | null> {
    try {
      const response = await this.fetchWithRetry(`${this.QUOTE_API}/quote`, {
        method: "POST",
        body: JSON.stringify({
          inputMint: new PublicKey(params.inputMint).toString(),
          outputMint: new PublicKey(params.outputMint).toString(),
          amount: params.amount,
          slippageBps: params.slippageBps,
          onlyDirectRoutes: false,
          asLegacyTransaction: false,
        }),
      });

      return response;
    } catch (error) {
      console.error("Error getting quote:", error);
      return null;
    }
  }

  public async executeSwap(
    quote: QuoteResponse,
    walletClient: any // GOAT wallet client
  ): Promise<SwapResponse | null> {
    try {
      const userPublicKey = walletClient.getAddress();

      // Get swap transaction
      const swapResponse = await this.fetchWithRetry(`${this.QUOTE_API}/swap`, {
        method: "POST",
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey,
          wrapUnwrapSOL: true,
        }),
      });

      // Execute transaction using GOAT wallet client
      const txid = await walletClient.sendTransaction(
        swapResponse.swapTransaction
      );

      return {
        txid,
        inputAmount: quote.inAmount,
        outputAmount: quote.outAmount,
      };
    } catch (error) {
      console.error("Error executing swap:", error);
      return null;
    }
  }

  public async getLiquidityDepth(
    tokenAddress: string,
    amountUsd: number
  ): Promise<{
    canFill: boolean;
    expectedSlippage: number;
  }> {
    try {
      // Get SOL price first (since we'll be swapping from SOL)
      const solPrice = await this.getTokenPrice(
        "So11111111111111111111111111111111111111112"
      );
      if (!solPrice) {
        throw new Error("Could not get SOL price");
      }

      // Convert USD amount to SOL
      const solAmount = amountUsd / solPrice;

      // Get quote to check slippage
      const quote = await this.getQuote({
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: tokenAddress,
        amount: solAmount * 1e9, // Convert to lamports
        slippageBps: 10000, // Allow high slippage for testing
      });

      if (!quote) {
        return { canFill: false, expectedSlippage: 100 };
      }

      return {
        canFill: true,
        expectedSlippage: quote.priceImpactPct,
      };
    } catch (error) {
      console.error("Error checking liquidity depth:", error);
      return { canFill: false, expectedSlippage: 100 };
    }
  }

  public async getTokenPrice(tokenAddress: string): Promise<number | null> {
    try {
      // Check cache first
      const cached = this.priceCache.get(tokenAddress);
      if (cached && Date.now() - cached.timestamp < this.CACHE_DURATION) {
        return cached.price;
      }

      const response = await this.fetchWithRetry(
        `${this.PRICE_API}/price?ids=${tokenAddress}`
      );

      const price = response?.data?.[tokenAddress]?.price || null;

      // Update cache
      if (price !== null) {
        this.priceCache.set(tokenAddress, {
          price,
          timestamp: Date.now(),
        });
      }

      return price;
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
