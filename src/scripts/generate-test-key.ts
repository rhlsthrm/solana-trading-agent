// src/scripts/generate-test-key.ts
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

function generateTestKey() {
  const keypair = Keypair.generate();

  console.log("\nGenerated Solana Keypair for testing:");
  console.log("===============================");
  console.log(`Public Key: ${keypair.publicKey.toString()}`);
  console.log("\nPrivate Key (Base58):");
  console.log(bs58.encode(keypair.secretKey));
  console.log("\nAdd this to your .env file as:");
  console.log(`SOLANA_PRIVATE_KEY=<the-above-private-key>`);
}

generateTestKey();
