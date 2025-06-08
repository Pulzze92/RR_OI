import dotenv from "dotenv";
import { BybitService } from "./services/bybit";
import { TelegramService } from "./services/telegram";
import { logger } from "./utils/logger";

dotenv.config();

const {
  BYBIT_API_KEY,
  BYBIT_API_SECRET,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID
} = process.env;

if (
  !BYBIT_API_KEY ||
  !BYBIT_API_SECRET ||
  !TELEGRAM_BOT_TOKEN ||
  !TELEGRAM_CHAT_ID
) {
  throw new Error("Missing required environment variables");
}

async function main() {
  try {
    const telegramService = new TelegramService(
      TELEGRAM_BOT_TOKEN as string,
      TELEGRAM_CHAT_ID as string
    );

    const handleTradeUpdate = async (message: string) => {
      await telegramService.sendMessage(message);
      logger.info("Trade update notification sent via Telegram.");
    };

    const handleSignalUpdate = async (message: string) => {
      await telegramService.sendMessage(message);
      logger.info("Signal update notification sent via Telegram.");
    };

    const bybitService = new BybitService(
      BYBIT_API_KEY as string,
      BYBIT_API_SECRET as string,
      handleTradeUpdate,
      handleSignalUpdate,
      undefined,
      true
    );

    await bybitService.start();

    logger.info("Bot started successfully after BybitService initialization.");

    process.on("SIGINT", async () => {
      logger.info("Shutting down...");
      bybitService.stop();
      process.exit(0);
    });

    process.on("uncaughtException", error => {
      logger.error("Uncaught Exception:", error);
      process.exit(1);
    });

    process.on("unhandledRejection", (reason, promise) => {
      logger.error("Unhandled Rejection at:", promise, "reason:", reason);
      process.exit(1);
    });
  } catch (error) {
    logger.error("Failed to start bot:", error);
    process.exit(1);
  }
}

main();
