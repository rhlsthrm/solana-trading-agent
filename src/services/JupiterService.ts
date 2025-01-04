import { Transaction } from "@solana/web3.js";
import {
  QuoteResponse,
  SolanaTransaction,
  SolanaWalletClient,
  SwapResponse,
  TokenInfo,
} from "../types/trade";

export class JupiterService {
  private readonly TOKENS_API = "https://tokens.jup.ag/";
  private readonly QUOTE_API = "https://quote-api.jup.ag/v6";
  private readonly LAMPORTS_PER_SOL = 1_000_000_000; // 1 SOL = 1 billion lamports

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

        const responseText = await response.text();

        if (!response.ok) {
          console.error("API Error:", {
            status: response.status,
            url: url,
            response: responseText,
          });
          throw new Error(
            `HTTP error! status: ${response.status}, response: ${responseText}`
          );
        }

        // Only try to parse as JSON if we have content
        if (responseText) {
          return JSON.parse(responseText);
        }
        return null;
      } catch (error) {
        lastError = error;
        console.error(`Attempt ${i + 1} failed:`, error);
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
      // Get basic token info
      const tokenResponse = await this.fetchWithRetry(
        `${this.TOKENS_API}token/${tokenAddress}`
      );
      if (!tokenResponse) {
        return null;
      }

      // Get price and liquidity info from V2 API
      const priceResponse = await this.fetchWithRetry(
        `https://api.jup.ag/price/v2?ids=${tokenAddress}&showExtraInfo=true`
      );

      const priceData = priceResponse?.data?.[tokenAddress];
      const extraInfo = priceData?.extraInfo;

      return {
        address: tokenResponse.address,
        symbol: tokenResponse.symbol,
        name: tokenResponse.name,
        volume24h: tokenResponse.daily_volume,
        liquidity: extraInfo?.depth?.buyPriceImpactRatio?.depth?.[100] || 0, // Use 100 SOL depth as liquidity indicator
        price: parseFloat(priceData?.price || "0"),
        isValid: true,
      };
    } catch (error) {
      console.error(`Error fetching info for token ${tokenAddress}:`, error);
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
      // REMOVED the lamports conversion since it's now handled in TradeExecutionService
      const amountToUse = Math.floor(params.amount);

      // Log the amount for debugging
      console.log("Quote amount:", {
        amount: amountToUse,
        inputMint: params.inputMint,
      });

      // Construct URL with proper encoding
      const queryParams = new URLSearchParams({
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        amount: amountToUse.toString(),
        slippageBps: params.slippageBps.toString(),
      });

      const url = `${this.QUOTE_API}/quote?${queryParams.toString()}`;
      console.log("Fetching quote from:", url);

      const quoteResponse = await this.fetchWithRetry(url, {
        headers: {
          Accept: "application/json",
        },
      });

      if (!quoteResponse) {
        console.log("No quote response received");
        return null;
      }

      // Log quote details for debugging
      console.log("Quote received:", {
        inputAmount: quoteResponse.inAmount,
        outputAmount: quoteResponse.outAmount,
        priceImpact: quoteResponse.priceImpactPct,
      });

      return quoteResponse;
    } catch (error: any) {
      console.error("Error getting quote:", {
        error: error instanceof Error ? error.message : "Unknown error",
        params,
        errorMessage: error instanceof Error ? error.message : "No message",
        errorStack: error instanceof Error ? error.stack : "No stack trace",
      });

      // Try to get response body for more details if available
      if (error instanceof Error && (error as any).response) {
        const text = await (error as any).response.text();
        console.error("Response body:", text);
      }

      return null;
    }
  }

  public async executeSwap(
    quote: QuoteResponse,
    walletClient: SolanaWalletClient
  ): Promise<SwapResponse | null> {
    try {
      const userPublicKey = walletClient.getAddress();

      console.log("Executing swap with params:", {
        inputAmount: quote.inAmount,
        outputAmount: quote.outAmount,
        userPublicKey: userPublicKey,
      });

      // Get swap transaction
      const swapResponse = await this.fetchWithRetry(`${this.QUOTE_API}/swap`, {
        method: "POST",
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: userPublicKey.toString(),
          wrapUnwrapSOL: true,
          useSharedAccounts: false, // Disabled shared accounts as per previous fix
          dynamicComputeUnitLimit: true,
          computeUnitPriceMicroLamports: "auto",
          asLegacyTransaction: true,
        }),
      });

      if (!swapResponse || !swapResponse.swapTransaction) {
        console.error("Invalid swap response:", swapResponse);
        if (swapResponse?.error) {
          console.error("Swap API error:", swapResponse.error);
        }
        return null;
      }

      // Check simulation results from swap response
      if (swapResponse.simulationError) {
        console.error("Simulation failed:", {
          error: swapResponse.simulationError,
          details: swapResponse.simulationResponse,
        });
        return null;
      }

      // Log the compute unit settings
      console.log("Compute units:", {
        limit: swapResponse.computeUnitLimit,
        price: swapResponse.prioritizationFeeLamports,
      });

      // Proceed with transaction if simulation passed
      const transactionData = Buffer.from(
        swapResponse.swapTransaction,
        "base64"
      );

      // Deserialize into Solana Transaction
      const transaction = Transaction.from(transactionData);

      // Convert to GOAT SDK format
      const goatTransaction: SolanaTransaction = {
        instructions: transaction.instructions,
        // Versioned transactions aren't supported in this flow, so we'll skip lookup tables
        addressLookupTableAddresses: undefined,
      };

      console.log("Prepared transaction:", {
        hasInstructions: transaction.instructions.length > 0,
        numInstructions: transaction.instructions.length,
        firstProgramId: transaction.instructions[0]?.programId.toString(),
        blockHash: transaction.recentBlockhash,
        feePayer: transaction.feePayer?.toString(),
      });

      // Execute using GOAT wallet client
      const result = await walletClient.sendTransaction(goatTransaction);
      console.log("Transaction executed:", result);

      return {
        txid: result.hash,
        inputAmount: quote.inAmount,
        outputAmount: quote.outAmount,
      };
    } catch (error: any) {
      console.error("Detailed swap execution error:", {
        error: error instanceof Error ? error.message : "Unknown error",
        name: error instanceof Error ? error.name : "Unknown",
        stack: error instanceof Error ? error.stack : "No stack trace",
        rawError: error,
      });
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
