import { createBot } from "./bot.js";
import { readConfig } from "./config.js";

async function main(): Promise<void> {
  let config;
  try {
    config = readConfig(process.env);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Invalid server configuration.",
    );
    process.exitCode = 1;
    return;
  }
  const bot = createBot(config);
  let stopping = false;
  const stop = () => {
    stopping = true;
    if (bot.isRunning()) {
      void bot.stop().catch(() => {
        console.error("Could not stop Telegram polling.");
        process.exitCode = 1;
      });
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await bot.start({
      allowed_updates: ["message"],
      onStart: () => {
        if (stopping) stop();
        else console.log("Nimbot Server started with Telegram long polling.");
      },
    });
  } catch {
    console.error(
      "Telegram connection failed. Check the bot token, network, and whether another instance is running.",
    );
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

await main();
