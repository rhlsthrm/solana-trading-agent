// generate-telegram-session.ts
// Usage: pnpm tsx generate-telegram-session.ts
// Make sure your .env file contains TELEGRAM_API_ID and TELEGRAM_API_HASH

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import input from "input";
import "dotenv/config";

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;

if (!apiId || !apiHash) {
  console.error(
    "Please set TELEGRAM_API_ID and TELEGRAM_API_HASH in your .env file."
  );
  process.exit(1);
}

async function main() {
  const stringSession = new StringSession(""); // Empty string for new session
  const client = new TelegramClient(stringSession, apiId, apiHash as string, {
    connectionRetries: 5,
  });
  await client.start({
    phoneNumber: async () => await input.text("Phone number: "),
    password: async () =>
      await input.text("Password (if 2FA enabled, else leave blank): "),
    phoneCode: async () => await input.text("Code (sent via Telegram): "),
    onError: (err) => console.log(err),
  });
  console.log("\nYour new TELEGRAM_SESSION string:\n");
  console.log(client.session.save());
  console.log(
    "\nCopy this value into your .env as TELEGRAM_SESSION (no quotes).\n"
  );
  process.exit();
}

main();
