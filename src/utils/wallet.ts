import { Connection, Keypair } from "@solana/web3.js";
import { solana } from "@goat-sdk/wallet-solana";
import { createKeypairFromSecret } from "./solana";
import * as fs from 'fs';
import { SolanaWalletClient } from "../types/trade";

/**
 * Initializes a Solana wallet client by trying different sources
 * 1. Environment variable SOLANA_PRIVATE_KEY
 * 2. test-wallet.json file
 * 
 * @returns The initialized Solana wallet client
 * @throws Error if wallet initialization fails
 */
export async function initializeWallet(): Promise<SolanaWalletClient> {
  try {
    // Try to load from environment variable first
    const privateKey = process.env.SOLANA_PRIVATE_KEY;
    if (privateKey) {
      const keypair = createKeypairFromSecret(privateKey);
      console.log(`Using wallet from environment: ${keypair.publicKey.toString()}`);
      
      const connection = new Connection(
        process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
        "confirmed"
      );
      
      return solana({
        keypair,
        connection,
      });
    }
    
    // If not in env, try to load from test-wallet.json
    console.log("No SOLANA_PRIVATE_KEY in environment, trying test-wallet.json");
    const walletData = fs.readFileSync("./test-wallet.json", "utf-8");
    const secretKey = new Uint8Array(JSON.parse(walletData));
    const keypair = Keypair.fromSecretKey(secretKey);
    console.log(`Using test wallet: ${keypair.publicKey.toString()}`);
    
    const connection = new Connection(
      process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
      "confirmed"
    );
    
    return solana({
      keypair,
      connection,
    });
  } catch (error) {
    console.error("Failed to load wallet:", error);
    throw new Error("Unable to load wallet. Please check your .env file or test-wallet.json");
  }
}

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
      console.log(`Using wallet from environment: ${keypair.publicKey.toString()}`);
    } else {
      // If not in env, try to load from test-wallet.json
      console.log("No SOLANA_PRIVATE_KEY in environment, trying test-wallet.json");
      const walletData = fs.readFileSync("./test-wallet.json", "utf-8");
      const secretKey = new Uint8Array(JSON.parse(walletData));
      keypair = Keypair.fromSecretKey(secretKey);
      console.log(`Using test wallet: ${keypair.publicKey.toString()}`);
    }
    
    const connection = new Connection(
      process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
      "confirmed"
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