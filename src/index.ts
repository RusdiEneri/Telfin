import dotenv from "dotenv";
dotenv.config();

import { createBot } from "./bot/index.js";
import { logger } from "./utils/logger.js";

const token = process.env.BOT_TOKEN;

if (!token) {
  logger.error("BOT_TOKEN tidak ditemukan di file .env. Pastikan file .env sudah diisi.");
  process.exit(1);
}

const bot = createBot(token);

// Handle graceful shutdown
const stop = () => {
  logger.info("Menghentikan bot...");
  bot.stop();
  process.exit(0);
};

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

logger.info("Memulai bot Telegram (long polling)...");
bot.start({
  onStart: (botInfo) => {
    logger.info(`Bot @${botInfo.username} berhasil berjalan! Menunggu pesan/foto...`);
  },
});
