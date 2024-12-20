import { config } from "dotenv";
import { createTelegramMonitorService } from "../services/telegram";

async function test() {
  // Load environment variables
  config();

  const telegramConfig = {
    apiId: Number(process.env.TELEGRAM_API_ID),
    apiHash: process.env.TELEGRAM_API_HASH || "",
    sessionStr: process.env.TELEGRAM_SESSION,
    dbPath: "trading.db",
  };

  console.log("Starting Telegram monitor test...");

  try {
    const monitor = createTelegramMonitorService(telegramConfig);
    await monitor.start();

    // Keep running for testing
    console.log("Monitor running. Press Ctrl+C to stop.");

    // Handle cleanup on exit
    process.on("SIGINT", async () => {
      console.log("Stopping monitor...");
      await monitor.stop();
      process.exit();
    });
  } catch (error) {
    console.error("Test failed:", error);
    process.exit(1);
  }
}

// Run test
test().catch(console.error);
