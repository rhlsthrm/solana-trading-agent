import { Transaction } from "@solana/web3.js";
import { SolanaWalletClient, TokenInfo } from "../types/trade";

export class JupiterService {
  // API endpoints
  private readonly QUOTE_API = "https://quote-api.jup.ag/v6";
  private readonly TOKENS_API = "https://token.jup.ag/all";
  private readonly PRICE_API = "https://lite-api.jup.ag/price/v2";
  private readonly WRAPPED_SOL = "So11111111111111111111111111111111111111112";

  // Price cache to reduce API calls
  private priceCache: Map<string, { price: number; timestamp: number }> =
    new Map();
  private readonly PRICE_CACHE_TTL = 60 * 1000; // 2 minutes cache validity

  // Token info cache
  private tokenInfoCache: Map<string, { info: TokenInfo; timestamp: number }> =
    new Map();
  private readonly TOKEN_INFO_CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache validity

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

    const response = await this.fetchWithRetry(url);
    return response;
  }

  public async executeSwap(
    quote: any,
    walletClient: SolanaWalletClient,
    maxRetries = 3
  ): Promise<{
    txid: string;
    inputAmount: number;
    outputAmount: number;
  } | null> {
    let retryCount = 0;
    
    while (retryCount <= maxRetries) {
      try {
        console.log(`Preparing swap attempt ${retryCount + 1}/${maxRetries + 1} with quote:`, {
          inAmount: quote.inAmount,
          outAmount: quote.outAmount,
          priceImpact: quote.priceImpactPct,
        });

        // Get transaction data from Jupiter with fresh blockhash
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
              // Always get fresh blockhash
              skipUserConfirmation: true,
            }),
          }
        );

        if (!swapTransaction) {
          console.error("No swap transaction received");
          // If we've run out of retries, return null
          if (retryCount >= maxRetries) return null;
          
          // Otherwise, wait and retry
          retryCount++;
          console.log(`Retrying transaction (${retryCount}/${maxRetries})...`);
          await new Promise(resolve => setTimeout(resolve, 2000 * retryCount));
          continue;
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
        const errorMessage = error?.message || '';
        const isBlockhashError = 
          errorMessage.includes("Blockhash not found") || 
          errorMessage.includes("blockhash") ||
          errorMessage.includes("0x1") || // Solana blockhash error code
          errorMessage.includes("expired");
        
        console.error(`Swap execution failed (attempt ${retryCount + 1}/${maxRetries + 1}):`, error);
        console.error("Error details:", {
          name: error?.name,
          message: error?.message,
          isBlockhashError,
        });
        
        // If we've run out of retries, return null
        if (retryCount >= maxRetries) return null;
        
        // Increase retry count
        retryCount++;
        
        // For blockhash errors, we need to wait longer before retrying
        // This gives the network time to produce new blocks
        const delayMs = isBlockhashError ? 
          5000 * retryCount : // 5-15 seconds for blockhash errors
          2000 * retryCount;  // 2-6 seconds for other errors
          
        console.log(`Waiting ${delayMs/1000} seconds before retry ${retryCount}/${maxRetries}...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    
    return null;
  }

  public async getTokenInfo(addressOrPool: string): Promise<TokenInfo | null> {
    try {
      // Check cache first
      const cachedData = this.tokenInfoCache.get(addressOrPool);
      const now = Date.now();

      if (
        cachedData &&
        now - cachedData.timestamp < this.TOKEN_INFO_CACHE_TTL
      ) {
        // No logging for cache hit - reduces spam
        return cachedData.info;
      }

      // Try to get the token from Jupiter token list first
      try {
        // The token API returns all tokens in one call
        const allTokensResponse = await this.fetchWithRetry(this.TOKENS_API);

        if (allTokensResponse && Array.isArray(allTokensResponse)) {
          // Find our token in the list
          const tokenData = allTokensResponse.find(
            (token) =>
              token.address === addressOrPool ||
              token.symbol?.toLowerCase() === addressOrPool.toLowerCase()
          );

          if (tokenData) {
            // Get the latest price using our getCurrentPrice method
            const currentPrice = await this.getCurrentPrice(tokenData.address);

            // Use the price we received, or fall back to token data price or null
            const finalPrice =
              currentPrice !== null ? currentPrice : tokenData.price || null;

            const tokenInfo = {
              address: tokenData.address,
              symbol: tokenData.symbol || "UNKNOWN",
              name: tokenData.name || tokenData.symbol || "Unknown Token",
              price: finalPrice,
              decimals: tokenData.decimals || 9,
              liquidity: tokenData.liquidity || 0,
              volume24h: tokenData.volume24h || 0,
              marketCap: tokenData.marketCap || 0,
              holders: tokenData.holders || 0,
              isValid: finalPrice !== null, // Only valid if price is available
            };

            // Update cache
            this.tokenInfoCache.set(addressOrPool, {
              info: tokenInfo,
              timestamp: now,
            });

            return tokenInfo;
          }
        }
      } catch (error) {
        const tokenApiError = error as Error;
        console.warn(
          `Error fetching from token list API: ${tokenApiError.message}`
        );
      }

      // Try to get the current price
      const currentPrice = await this.getCurrentPrice(addressOrPool);

      if (currentPrice !== null) {
        // Try to get token decimals from the blockchain
        let decimals = 9;
        try {
          const { getTokenInfo } = await import("../utils/token-balance");
          const onchainInfo = await getTokenInfo(addressOrPool);
          if (onchainInfo && typeof onchainInfo.decimals === 'number') {
            decimals = onchainInfo.decimals;
            console.log(`Retrieved on-chain decimals for ${addressOrPool}: ${decimals}`);
          }
        } catch (decimalError) {
          console.warn(`Could not get on-chain decimals for ${addressOrPool}, defaulting to 9:`, decimalError);
        }

        // Create minimal token info with the current price
        const tokenInfo = {
          address: addressOrPool,
          symbol: addressOrPool.substring(0, 5), // Use first 5 chars of address as symbol
          name: addressOrPool.substring(0, 8), // Use first 8 chars of address as name
          price: currentPrice,
          decimals: decimals,
          liquidity: 0,
          volume24h: 0,
          marketCap: 0,
          holders: 0,
          isValid: true,
        };

        // Update cache
        this.tokenInfoCache.set(addressOrPool, {
          info: tokenInfo,
          timestamp: now,
        });

        return tokenInfo;
      }

      // If we couldn't get a price, return minimal info with isValid: false
      console.warn(
        `Could not get price for ${addressOrPool} - returning invalid token info`
      );
      
      // Try to get token decimals from the blockchain even for invalid tokens
      let decimals = 9; // Default to 9 for meme tokens
      try {
        const { getTokenInfo } = await import("../utils/token-balance");
        const onchainInfo = await getTokenInfo(addressOrPool);
        if (onchainInfo && typeof onchainInfo.decimals === 'number') {
          decimals = onchainInfo.decimals;
          console.log(`Retrieved on-chain decimals for invalid token ${addressOrPool}: ${decimals}`);
        }
      } catch (decimalError) {
        console.warn(`Could not get on-chain decimals for invalid token ${addressOrPool}, defaulting to 9`);
      }
      
      const invalidTokenInfo = {
        address: addressOrPool,
        symbol: addressOrPool.substring(0, 5),
        name: addressOrPool.substring(0, 8),
        price: null,
        decimals: decimals,
        liquidity: 0,
        volume24h: 0,
        marketCap: 0,
        holders: 0,
        isValid: false,
      };

      // We still cache invalid results but with a shorter TTL
      // We'll set the timestamp to be almost expired
      const shorterTtl = now - (this.TOKEN_INFO_CACHE_TTL - 60000); // Just 1 minute validity
      this.tokenInfoCache.set(addressOrPool, {
        info: invalidTokenInfo,
        timestamp: shorterTtl,
      });

      return invalidTokenInfo;
    } catch (error) {
      console.error("Error getting token info:", error);

      // Even on error, return minimal token info so the app doesn't crash
      return {
        address: addressOrPool,
        symbol: "UNKNOWN",
        name: "Unknown Token",
        price: null,
        decimals: 6,
        liquidity: 0,
        volume24h: 0,
        marketCap: 0,
        holders: 0,
        isValid: false,
      };
    }
  }

  /**
   * Get the current price of a token directly from the Jupiter price API
   */
  public async getCurrentPrice(tokenAddress: string): Promise<number | null> {
    try {
      // Check cache first
      const cachedData = this.priceCache.get(tokenAddress);
      const now = Date.now();

      if (cachedData && now - cachedData.timestamp < this.PRICE_CACHE_TTL) {
        // No logging for cached prices - reduces console spam
        return cachedData.price;
      }

      // Cache miss or expired - fetch from API
      const url = `${this.PRICE_API}?ids=${tokenAddress}&_t=${now}`; // Cache-busting timestamp

      // No logging for API requests - reduces noise
      const response = await this.fetchWithRetry(url);

      // Check if we got a valid response
      if (response?.data?.[tokenAddress]?.price) {
        const price = parseFloat(response.data[tokenAddress].price);

        // Update cache
        this.priceCache.set(tokenAddress, { price, timestamp: now });

        return price;
      }

      // Only log warnings for missing data
      console.warn(`No price data available for ${tokenAddress}`);
      return null;
    } catch (error) {
      console.error(`Error getting current price for ${tokenAddress}:`, error);
      return null;
    }
  }
}

export const createJupiterService = () => {
  return new JupiterService();
};
