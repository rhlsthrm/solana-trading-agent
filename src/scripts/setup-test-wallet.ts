// src/scripts/setup-test-wallet.ts
import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  Keypair,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import bs58 from "bs58";
import { config } from "dotenv";

async function setupTestWallet() {
  // Load environment variables
  config();

  // Initialize connection to devnet
  const connection = new Connection(
    "https://api.devnet.solana.com",
    "confirmed"
  );

  // Get keypair from private key
  const privateKeyBytes = bs58.decode(process.env.SOLANA_PRIVATE_KEY!);
  const keypair = Keypair.fromSecretKey(privateKeyBytes);
  const base64PrivateKey = Buffer.from(keypair.secretKey).toString("base64");
  console.log(`Base64 Private Key: ${base64PrivateKey}`);
  const publicKey = keypair.publicKey;

  console.log("\nSetting up test wallet...");
  console.log("===============================");
  console.log(`Wallet Address: ${publicKey.toString()}`);

  // Check current balance
  const balance = await connection.getBalance(publicKey);
  console.log(`Current balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  // Request airdrop if balance is low
  if (balance < LAMPORTS_PER_SOL) {
    console.log("\nRequesting SOL airdrop...");
    try {
      const signature = await connection.requestAirdrop(
        publicKey,
        2 * LAMPORTS_PER_SOL // Request 2 SOL
      );
      await connection.confirmTransaction(signature);
      const newBalance = await connection.getBalance(publicKey);
      console.log(`New balance: ${newBalance / LAMPORTS_PER_SOL} SOL`);
    } catch (error) {
      console.error("Error requesting airdrop:", error);
    }
  }

  // Create a test SPL token
  console.log("\nCreating test SPL token...");
  try {
    const decimals = 6;
    const mint = await createMint(
      connection,
      keypair,
      publicKey,
      publicKey,
      decimals
    );

    console.log(`Created token mint: ${mint.toString()}`);

    // Create token account
    const tokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      keypair,
      mint,
      publicKey
    );

    console.log(`Created token account: ${tokenAccount.address.toString()}`);

    // Mint some tokens
    const amount = 1000000000; // 1000 tokens with 6 decimals
    await mintTo(
      connection,
      keypair,
      mint,
      tokenAccount.address,
      keypair,
      amount
    );

    console.log(
      `Minted ${amount / Math.pow(10, decimals)} TEST tokens to your account`
    );
  } catch (error) {
    console.error("Error creating test token:", error);
  }
}

// Run setup
setupTestWallet().catch(console.error);
