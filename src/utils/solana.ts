import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

export function createKeypairFromSecret(secretString: string): Keypair {
  try {
    // Try base58 format first (typical Solana private key format)
    try {
      const decoded = bs58.decode(secretString);
      return Keypair.fromSecretKey(decoded);
    } catch (e) {
      // Not base58, continue to next format
    }

    // Try base64 format
    try {
      const decoded = Buffer.from(secretString, "base64");
      return Keypair.fromSecretKey(decoded);
    } catch (e) {
      // Not base64, continue to next format
    }

    // Try hex format
    try {
      const cleaned = secretString.startsWith("0x")
        ? secretString.slice(2)
        : secretString;
      const decoded = Buffer.from(cleaned, "hex");
      return Keypair.fromSecretKey(decoded);
    } catch (e) {
      // Not hex, throw error
    }

    throw new Error("Invalid private key format");
  } catch (error) {
    throw new Error(
      `Failed to create keypair: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
  }
}
