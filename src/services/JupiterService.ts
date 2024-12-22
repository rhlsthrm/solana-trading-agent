import { PublicKey } from "@solana/web3.js";

interface JupiterToken {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  logoURI?: string;
  tags: string[];
  daily_volume: number;
}

interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  liquidity: number;
  volume24h: number;
  price?: number;
  verified: boolean;
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
  private readonly QUOTE_API = "https://quote-api.jup.ag/v6";

  constructor(private config: { minLiquidity: number; minVolume24h: number }) {}

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

  public async getTokenInfo(tokenAddress: string): Promise<TokenInfo | null> {
    try {
      console.log(`Fetching info for token ${tokenAddress}...`);

      // Full URL logging
      const fullUrl = `${this.TOKENS_API}token/${tokenAddress}`;
      console.log(`Full URL being called: ${fullUrl}`);

      const tokenResponse = await this.fetchWithRetry(fullUrl);

      // More detailed response logging
      console.log("Token Response:", JSON.stringify(tokenResponse, null, 2));

      if (!tokenResponse) {
        console.warn(`No token found for address: ${tokenAddress}`);
        return null;
      }

      const token = tokenResponse as JupiterToken;
      const priceData = await this.fetchWithRetry(
        `${
          this.QUOTE_API
        }/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${tokenAddress}&amount=${
          10 ** token.decimals
        }`,
        {
          headers: {
            Accept: "application/json",
          },
        }
      );

      console.log("priceData", priceData);

      return {
        address: token.address,
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        volume24h: token.daily_volume,
        verified: true,
        liquidity: 0,
        price: 0,
      };
    } catch (error) {
      console.error(`Detailed error fetching info for token ${tokenAddress}:`, {
        error,
        errorName: error.name,
        errorMessage: error.message,
        errorStack: error.stack,
      });
      return null;
    }
  }

  public async getQuote(params: {
    inputMint: string;
    outputMint: string;
    amount: number;
    slippageBps: number;
  }): Promise<QuoteResponse | null> {
    try {
      const quoteResponse = await this.fetchWithRetry(
        `${this.QUOTE_API}/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${params.outputMint}&amount=${params.amount}`,
        {
          headers: {
            Accept: "application/json",
          },
        }
      );

      return quoteResponse;
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
}

export const createJupiterService = (config: {
  minLiquidity: number;
  minVolume24h: number;
}) => {
  return new JupiterService(config);
};
