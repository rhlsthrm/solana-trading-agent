import { WalletClientBase } from "@goat-sdk/core";
import {
  Transaction,
  VersionedTransaction,
  TransactionInstruction,
} from "@solana/web3.js";
type Chain = {
  type: "evm" | "solana" | "aptos" | "chromia";
  id?: number;
};

type Signature = {
  signature: string;
};
type Balance = {
  decimals: number;
  symbol: string;
  name: string;
  value: bigint;
};
interface WalletClient {
  getAddress: () => string;
  getChain: () => Chain;
  signMessage: (message: string) => Promise<Signature>;
  balanceOf: (address: string) => Promise<Balance>;
}

type SolanaTransaction = {
  instructions: TransactionInstruction[];
  addressLookupTableAddresses?: string[];
};
type SolanaReadRequest = {
  accountAddress: string;
};
type SolanaReadResult = {
  value: unknown;
};
type SolanaTransactionResult = {
  hash: string;
};
interface SolanaWalletClient extends WalletClient {
  sendTransaction: (
    transaction: SolanaTransaction
  ) => Promise<SolanaTransactionResult>;
  read: (request: SolanaReadRequest) => Promise<SolanaReadResult>;
}

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
      console.log("fetching token info from", fullUrl);

      const tokenResponse = await this.fetchWithRetry(fullUrl);

      if (!tokenResponse) {
        console.warn(`No token found for address: ${tokenAddress}`);
        return null;
      }

      const token = tokenResponse as JupiterToken;

      return {
        address: token.address,
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        volume24h: token.daily_volume,
        verified: true,
        liquidity: 0, // gotta fix
        price: 0, // gotta fix
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
      console.log("fetching quote for", params.outputMint);
      const quoteResponse = await this.fetchWithRetry(
        `${this.QUOTE_API}/quote?inputMint=${params.inputMint}&outputMint=${params.outputMint}&amount=${params.amount}`,
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
    walletClient: SolanaWalletClient
  ): Promise<SwapResponse | null> {
    try {
      const userPublicKey = walletClient.getAddress();

      // Get swap transaction
      const swapResponse = await this.fetchWithRetry(`${this.QUOTE_API}/swap`, {
        method: "POST",
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: userPublicKey.toString(),
          wrapUnwrapSOL: true,
          useSharedAccounts: true,
          dynamicComputeUnitLimit: true,
          asLegacyTransaction: true, // Force legacy transaction format
        }),
      });

      if (!swapResponse || !swapResponse.swapTransaction) {
        console.error("No swap transaction in response:", swapResponse);
        return null;
      }

      // Decode base64 transaction data
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
    } catch (error) {
      console.error("Detailed swap execution error:", {
        error: error.message,
        name: error.name,
        stack: error.stack,
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
