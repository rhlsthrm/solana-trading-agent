export interface TokenMetrics {
  liquidity: number;
  volume24h: number;
}

export interface TokenInfo {
  address: string;
  symbol: string;
  liquidity: number;
  volume24h: number;
}

export interface JupiterToken {
  address: string;
  symbol: string;
  decimals: number;
  coingeckoId?: string;
  logoPNG?: string;
}

export interface JupiterPair {
  inputMint: string;
  outputMint: string;
  liquidity: number;
  volume24h?: number;
  price?: number;
}
