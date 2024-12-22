// telegram.ts
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage } from "telegram/events";
import input from "input";
import { IAgentRuntime, generateObject, ModelClass } from "@ai16z/eliza";
import { z } from "zod";

// Define a schema for signal parsing
const SignalSchema = z.object({
  isTradeSignal: z.boolean(),
  type: z.enum(["BUY", "SELL", "UNKNOWN"]).optional(),
  tokenAddress: z.string().optional(),
  price: z.number().optional(),
  riskLevel: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
  confidence: z.number().min(0).max(100).optional(),
  timeframe: z.string().optional(),
});

export class TelegramMonitorService {
  private client: TelegramClient;
  private channelIds: string[] = ["@DegenSeals"];
  private runtime: IAgentRuntime;

  constructor(
    private config: {
      apiId: number;
      apiHash: string;
      sessionStr?: string;
      runtime: IAgentRuntime;
    }
  ) {
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
    this.runtime = config.runtime;
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

        console.log(`📣 New message from ${chat.username}:`);
        console.log(message.text);

        try {
          // Use Claude to parse the signal
          const signalResult = await this.parseSignalWithClaude(message.text);

          if (signalResult.isTradeSignal) {
            console.log("🚨 Trading Signal Detected!");
            console.log(
              "Signal Details:",
              JSON.stringify(signalResult, null, 2)
            );

            // Here you can add logic to execute trade or further process the signal
          }
        } catch (parseError) {
          console.error("Error parsing signal:", parseError);
        }
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

  private async parseSignalWithClaude(text: string) {
    const prompt = `
Analyze the following Telegram message and determine if it's a trading signal:

Message:
${text}

Instructions:
1. Determine if this is a trading signal
2. If it is a signal, extract:
   - Signal type (BUY/SELL/UNKNOWN)
   - Token address (if present)
   - Entry price (if mentioned)
   - Risk level (LOW/MEDIUM/HIGH)
   - Confidence in the signal (0-100)
   - Expected timeframe

Provide a structured response following the schema:
`;

    const result = await generateObject({
      runtime: this.runtime,
      context: prompt,
      modelClass: ModelClass.SMALL, // Use a smaller, faster model
      schema: SignalSchema,
    });

    return result.object;
  }

  async stop() {
    try {
      console.log("Disconnecting from Telegram...");
      await this.client.disconnect();
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
  runtime: IAgentRuntime;
}) => {
  return new TelegramMonitorService(config);
};
