import bs58 from "bs58";

const base58PrivateKey = "x";

// Decode from base58 to Uint8Array (64-bit format)
const privateKeyBytes = bs58.decode(base58PrivateKey);

console.log("Private Key (Uint8Array):", privateKeyBytes);
console.log("Private Key (Hex):", Buffer.from(privateKeyBytes).toString("hex"));
console.log(
  "Private Key (Base64):",
  Buffer.from(privateKeyBytes).toString("base64")
);
