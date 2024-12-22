import { createKeypairFromSecret } from "./solana";

import { solana } from "@goat-sdk/wallet-solana";
import { Connection } from "@solana/web3.js";

// Get wallet client
function getWalletClient(getSetting: (key: string) => string | undefined) {
  const privateKeyStr = getSetting("SOLANA_PRIVATE_KEY");
  if (!privateKeyStr) {
    throw new Error("SOLANA_PRIVATE_KEY not configured");
  }

  const rpcUrl = getSetting("SOLANA_RPC_URL");
  if (!rpcUrl) {
    throw new Error("SOLANA_RPC_URL not configured");
  }

  try {
    // Create keypair from secret
    const keypair = createKeypairFromSecret(privateKeyStr);
    console.log(`Wallet public key: ${keypair.publicKey.toString()}`);

    // Create Solana connection
    const connection = new Connection(rpcUrl, "confirmed");

    // Return both wallet client and connection
    return {
      walletClient: solana({
        keypair,
        connection,
      }),
      connection,
    };
  } catch (error) {
    throw new Error(
      `Failed to initialize wallet: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
  }
}

export { getWalletClient };
