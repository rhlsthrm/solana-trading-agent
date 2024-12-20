import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage } from "telegram/events";
import input from "input";
import Database from "better-sqlite3";
import { parseSignal } from "../utils/parseSignal";

export class TelegramMonitorService {
  private client: TelegramClient;
  private db: Database.Database;
  private channelIds: string[] = ["@DegenSeals"];

  constructor(
    private config: {
      apiId: number;
      apiHash: string;
      sessionStr?: string;
      dbPath: string;
    }
  ) {
    this.db = new Database(config.dbPath);

    // Initialize Telegram client with string session
    const stringSession = new StringSession(config.sessionStr || "");
    this.client = new TelegramClient(
      stringSession,
      config.apiId,
      config.apiHash,
      {
        connectionRetries: 5,
      }
    );
  }

  async start() {
    try {
      console.log("Starting Telegram monitor service...");

      // Start the client with interactive login if needed
      await this.client.start({
        phoneNumber: async () => await input.text("Please enter your number: "),
        password: async () => await input.text("Please enter your password: "),
        phoneCode: async () =>
          await input.text("Please enter the code you received: "),
        onError: (err) => console.log(err),
      });

      console.log("You should now be connected.");
      console.log(
        "Session string (save this to TELEGRAM_SESSION in .env):",
        this.client.session.save()
      );

      // Add event handler for new messages
      this.client.addEventHandler(async (event: any) => {
        const message = event.message;
        const chat = await message.getChat();

        // Check if message is from our target channel
        if (!this.channelIds.includes(chat.username)) {
          return;
        }

        console.log(`New message from ${chat.username}:`, message.text);

        // Parse signal from message
        const signal = parseSignal(message.text);
        if (!signal) {
          console.log("No trading signal found in message");
          return;
        }

        // Store signal in database
        const stmt = this.db.prepare(`
          INSERT INTO signals (
            id,
            source,
            token_address,
            signal_type,
            price,
            timestamp,
            processed
          ) VALUES (?, ?, ?, ?, ?, datetime('now'), false)
        `);

        stmt.run(
          signal.id,
          "telegram",
          signal.tokenAddress,
          signal.type,
          signal.price
        );

        console.log("Stored new signal:", signal);
      }, new NewMessage({}));

      // Try to verify we can access the channel
      for (const channelId of this.channelIds) {
        try {
          await this.client.getMessages(channelId, { limit: 1 });
          console.log(`Successfully connected to ${channelId}`);
        } catch (error) {
          console.error(`Error accessing ${channelId}:`, error);
        }
      }

      console.log("Monitoring channels:", this.channelIds);
    } catch (error) {
      console.error("Error starting Telegram service:", error);
      throw error;
    }
  }

  async stop() {
    try {
      console.log("Disconnecting from Telegram...");
      await this.client.disconnect();
      this.db.close();
      console.log("Cleanup completed successfully");
    } catch (error) {
      console.error("Error during cleanup:", error);
    }
  }
}

export const createTelegramMonitorService = (config: {
  apiId: number;
  apiHash: string;
  sessionStr?: string;
  dbPath: string;
}) => {
  return new TelegramMonitorService(config);
};
