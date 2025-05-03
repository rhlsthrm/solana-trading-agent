import { Transaction, VersionedTransaction } from "@solana/web3.js";
import { SolanaWalletClient, TokenInfo } from "../types/trade";

export class JupiterService {
  private readonly QUOTE_API = "https://quote-api.jup.ag/v6";
  private readonly TOKENS_API = "https://tokens.jup.ag";
  private readonly PRICE_API = "https://price.jup.ag/v4";

  private async fetchWithRetry(
    url: string,
    options: RequestInit = {},
    retries = 3
  ): Promise<any> {
    let lastError;
    const defaultHeaders = {
      "Content-Type": "application/json",
      "User-Agent": "JupiterSwapBot/1.0",
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

        const text = await response.text();
        return text ? JSON.parse(text) : null;
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

  public async getQuote(params: {
    inputMint: string;
    outputMint: string;
    amount: number;
  }): Promise<any> {
    const queryParams = new URLSearchParams({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount.toString(),
      slippageBps: "1000", // 10% slippage
      onlyDirectRoutes: "true", // For better reliability
    });

    const url = `${this.QUOTE_API}/quote?${queryParams}`;
    console.log("Fetching quote:", url);

    const response = await this.fetchWithRetry(url);
    console.log("Quote response:", response);
    return response;
  }

  public async executeSwap(
    quote: any,
    walletClient: SolanaWalletClient
  ): Promise<{
    txid: string;
    inputAmount: number;
    outputAmount: number;
  } | null> {
    try {
      console.log("Preparing swap with quote:", {
        inAmount: quote.inAmount,
        outAmount: quote.outAmount,
        priceImpact: quote.priceImpactPct,
      });

      // Get transaction data from Jupiter
      const { swapTransaction } = await this.fetchWithRetry(
        `${this.QUOTE_API}/swap`,
        {
          method: "POST",
          body: JSON.stringify({
            quoteResponse: quote,
            userPublicKey: walletClient.getAddress(),
            wrapAndUnwrapSol: true,
            computeUnitPriceMicroLamports: "auto",
            dynamicComputeUnitLimit: true,
            asLegacyTransaction: true,
          }),
        }
      );

      if (!swapTransaction) {
        console.error("No swap transaction received");
        return null;
      }

      console.log("Got swap transaction data");

      // Decode base64 transaction data
      const transactionData = Buffer.from(swapTransaction, "base64");

      // Deserialize into Transaction
      const transaction = Transaction.from(transactionData);

      // Convert to format expected by GOAT SDK
      const goatTransaction = {
        instructions: transaction.instructions,
        // No lookup tables since we're using legacy transactions
      };

      console.log(
        "Sending transaction with instructions count:",
        transaction.instructions.length
      );

      // Execute using wallet client
      const result = await walletClient.sendTransaction(goatTransaction);

      console.log("Transaction sent:", result);

      return {
        txid: result.hash,
        inputAmount: quote.inAmount,
        outputAmount: quote.outAmount,
      };
    } catch (error: any) {
      console.error("Swap execution failed:", error);
      console.error("Error details:", {
        name: error.name,
        message: error.message,
        stack: error.stack,
      });
      return null;
    }
  }

  public async getTokenInfo(addressOrPool: string): Promise<TokenInfo | null> {
    try {
      const response = await fetch(`${this.TOKENS_API}/token/${addressOrPool}`);
      if (!response.ok) {
        console.error(`Failed to get token info: ${response.statusText}`);
        return null;
      }

      const data = await response.json();
      return {
        address: data.address,
        symbol: data.symbol,
        name: data.name,
        price: data.price,
        liquidity: data.liquidity,
        volume24h: data.volume24h,
        marketCap: data.marketCap,
        holders: data.holders,
        isValid: true,
      };
    } catch (error) {
      console.error("Error getting token info:", error);
      return null;
    }
  }
}

export const createJupiterService = () => new JupiterService();
