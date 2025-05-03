import { Connection, PublicKey } from "@solana/web3.js";

/**
 * Gets the actual token balance from the blockchain.
 * Creates a new connection if needed to avoid dependency issues.
 *
 * @param tokenMintAddress The token's mint address
 * @param walletAddress The wallet address to check
 * @param connection Optional Solana connection
 * @returns The token balance as a bigint or null if an error occurs
 */
export async function getTokenBalance(
  tokenMintAddress: string,
  walletAddress: string,
  connection?: Connection
): Promise<bigint | null> {
  try {
    // Create or use provided connection
    const conn =
      connection ||
      new Connection(
        process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
        "confirmed"
      );

    // Find all token accounts owned by this wallet for the specified token
    const tokenAccounts = await conn.getTokenAccountsByOwner(
      new PublicKey(walletAddress),
      {
        mint: new PublicKey(tokenMintAddress),
      }
    );

    // If no token accounts found, the wallet doesn't own this token
    if (tokenAccounts.value.length === 0) {
      return BigInt(0);
    }

    // Get the token account data (typically only one per token per wallet)
    const tokenAccount = tokenAccounts.value[0];
    const accountInfo = await conn.getAccountInfo(tokenAccount.pubkey);

    if (!accountInfo) {
      return null;
    }

    // The token amount is at bytes 64-71 in TOKEN_PROGRAM_ID account data
    const data = accountInfo.data;
    const amountBuffer = data.slice(64, 72);
    const amount = amountBuffer.readBigUInt64LE(0);

    return amount;
  } catch (error) {
    return null;
  }
}

/**
 * Utility function to check if a wallet has enough tokens to sell
 *
 * @param tokenMintAddress Token address to check
 * @param requiredAmount Amount needed for the sell operation
 * @param walletAddress Wallet address to check
 * @param connection Optional Solana connection
 * @returns Object with hasEnough flag and actualBalance
 */
export async function hasEnoughTokens(
  tokenMintAddress: string,
  requiredAmount: number,
  walletAddress: string,
  connection?: Connection
): Promise<{ hasEnough: boolean; actualBalance: bigint | null }> {
  try {
    const actualBalance = await getTokenBalance(
      tokenMintAddress,
      walletAddress,
      connection
    );

    if (actualBalance === null) {
      return { hasEnough: false, actualBalance: null };
    }

    // Compare with the required amount
    const hasEnough = actualBalance >= BigInt(requiredAmount);

    return { hasEnough, actualBalance };
  } catch (error) {
    return { hasEnough: false, actualBalance: null };
  }
}

/**
 * Gets token metadata including decimals from the mint
 *
 * @param tokenMintAddress The token's mint address
 * @param connection Optional Solana connection
 * @returns Token info with decimals and symbol, or null if error
 */
export async function getTokenInfo(
  tokenMintAddress: string,
  connection?: Connection
): Promise<{ decimals: number; symbol: string } | null> {
  try {
    // Create or use provided connection
    const conn =
      connection ||
      new Connection(
        process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
        "confirmed"
      );

    const mintInfo = await conn.getAccountInfo(new PublicKey(tokenMintAddress));

    if (!mintInfo) {
      return null;
    }

    // The decimals value is at byte 44 in mint data structure
    const decimals = mintInfo.data[44];

    // Simple placeholder for symbol
    return {
      decimals,
      symbol: `TOKEN-${tokenMintAddress.slice(0, 4)}`,
    };
  } catch (error) {
    return null;
  }
}
