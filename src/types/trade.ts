import { TransactionInstruction } from "@solana/web3.js";

export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  price: number | null;
  decimals: number;
  marketCap?: number;
  liquidity?: number;
  volume24h?: number;
  holders?: number;
  isValid: boolean;
}

export interface TradeSignal {
  id: string;
  tokenAddress: string;
  type: "BUY" | "SELL";
  price?: number;
  confidence: number;
}

export interface Trade {
  id: string;
  tokenAddress: string;
  signalId: string;
  entryPrice: number;
  positionSize: number;
  stopLossPrice: number;
  status: "PENDING" | "EXECUTED" | "FAILED" | "CLOSED";
}

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

export type SolanaTransaction = {
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
export interface SolanaWalletClient extends WalletClient {
  sendTransaction: (
    transaction: SolanaTransaction
  ) => Promise<SolanaTransactionResult>;
  read: (request: SolanaReadRequest) => Promise<SolanaReadResult>;
  // Additional properties used in the application
  publicKey?: any;
  keypair?: {
    publicKey: any;
  };
  address?: string;
  [key: string]: any; // Index signature to allow string indexing
}

export interface QuoteResponse {
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

export interface SwapResponse {
  txid: string;
  inputAmount: number;
  outputAmount: number;
}
