import dotenv from "dotenv";
dotenv.config();

import db from "./db/index.js";
import { createBot, BOT_COMMANDS } from "./bot/index.js";
import { logger } from "./utils/logger.js";
import { cleanupPendingUploads } from "./services/receipt.service.js";

const token = process.env.BOT_TOKEN;

if (!token) {
  logger.error("BOT_TOKEN tidak ditemukan di file .env. Pastikan file .env sudah diisi.");
  process.exit(1);
}

const bot = createBot(token);

// Handle graceful shutdown (SIGINT, SIGTERM from PM2/OS)
let isShuttingDown = false;

const gracefulShutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Menerima sinyal ${signal}. Memulai graceful shutdown...`);

  try {
    // 1. Stop receiving new updates from Telegram
    logger.info("1. Menghentikan bot Telegram...");
    bot.stop();

    // 2. Clean hanging temporary files in uploads/
    logger.info("2. Membersihkan file temporary di uploads/...");
    const cleaned = cleanupPendingUploads();
    logger.info(`   ${cleaned} file temporary dibersihkan.`);

    // 3. Close SQLite connection cleanly
    logger.info("3. Menutup koneksi database SQLite...");
    db.close();

    logger.info("Graceful shutdown berhasil diselesaikan.");
  } catch (err) {
    logger.error("Error saat melakukan graceful shutdown:", err);
  } finally {
    process.exit(0);
  }
};

process.once("SIGINT", () => gracefulShutdown("SIGINT"));
process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));

logger.info("Memulai bot Telegram (long polling)...");
bot.start({
  onStart: async (botInfo) => {
    logger.info(`Bot @${botInfo.username} berhasil berjalan! Menunggu pesan/foto...`);
    try {
      await bot.api.setMyCommands(BOT_COMMANDS);
      logger.info("Menu commands Telegram berhasil disinkronkan.");
    } catch (cmdErr) {
      logger.error("Gagal menyinkronkan menu commands Telegram:", cmdErr);
    }
  },
});
