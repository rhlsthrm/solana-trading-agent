import type { IAgentRuntime, Memory, State } from "@ai16z/eliza";

function getWalletProvider(walletClient: any) {
  return {
    async get(
      runtime: IAgentRuntime,
      message: Memory,
      state?: State
    ): Promise<string | null> {
      try {
        const address = walletClient.getAddress();
        const balance = await walletClient.balanceOf(address);

        // Debug log to see what we're getting
        console.log("Raw balance:", balance);

        // Handle balance properly based on its type
        let solBalance: string;
        if (balance && typeof balance === "object" && "toString" in balance) {
          // If it's a BN or similar object with toString()
          solBalance = (Number(balance.toString()) / 1e9).toFixed(4);
        } else if (typeof balance === "number") {
          solBalance = (balance / 1e9).toFixed(4);
        } else {
          solBalance = "Unknown";
          console.error("Unexpected balance type:", typeof balance);
        }

        return `Solana Wallet Address: ${address}\nBalance: ${solBalance} SOL`;
      } catch (error) {
        console.error("Error in Solana wallet provider:", error);
        return null;
      }
    },
  };
}

export default getWalletProvider;
