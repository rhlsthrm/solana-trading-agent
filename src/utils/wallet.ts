import { Connection, Keypair } from "@solana/web3.js";
import { solana } from "@goat-sdk/wallet-solana";
import { createKeypairFromSecret } from "./solana";
import * as fs from 'fs';
import { SolanaWalletClient } from "../types/trade";

/**
 * Initializes a Solana wallet client and returns both the client and the connection
 * This is used by the telegram-monitor which needs both
 */
export async function initializeWalletWithConnection(): Promise<{
  walletClient: SolanaWalletClient;
  connection: Connection;
}> {
  try {
    // Try to load from environment variable first
    const privateKey = process.env.SOLANA_PRIVATE_KEY;
    let keypair: Keypair;
    
    if (privateKey) {
      keypair = createKeypairFromSecret(privateKey);
    } else {
      // If not in env, try to load from test-wallet.json
      const walletData = fs.readFileSync("./test-wallet.json", "utf-8");
      const secretKey = new Uint8Array(JSON.parse(walletData));
      keypair = Keypair.fromSecretKey(secretKey);
    }
    
    const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
    
    const connection = new Connection(
      rpcUrl,
      {
        commitment: "confirmed",
        confirmTransactionInitialTimeout: 60000,
        disableRetryOnRateLimit: false
      }
    );
        
    const walletClient = solana({
      keypair,
      connection,
    });
    
    return {
      walletClient,
      connection,
    };
  } catch (error) {
    console.error("Failed to load wallet:", error);
    throw new Error("Unable to load wallet. Please check your .env file or test-wallet.json");
  }
}