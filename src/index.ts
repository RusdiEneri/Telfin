import dotenv from "dotenv";
dotenv.config();

import db from "./db/index.js";
import { createBot, BOT_COMMANDS, getAllowedUserIds } from "./bot/index.js";
import { logger } from "./utils/logger.js";
import { cleanupPendingUploads } from "./services/receipt.service.js";
import { getTodayDayJakarta, getTodayDateJakarta } from "./utils/date.js";
import { formatRupiah } from "./utils/money.js";
import { getDueRecurrings, markRecurringReminded } from "./services/transaction.service.js";

const token = process.env.BOT_TOKEN;

if (!token) {
  logger.error("BOT_TOKEN tidak ditemukan di file .env. Pastikan file .env sudah diisi.");
  process.exit(1);
}

const bot = createBot(token);

export async function checkRecurringReminders(botInstance: typeof bot): Promise<number> {
  try {
    const todayDay = getTodayDayJakarta();
    const todayStr = getTodayDateJakarta();
    const dueItems = getDueRecurrings(todayDay, todayStr);

    if (dueItems.length === 0) {
      return 0;
    }

    const allowedUserIds = getAllowedUserIds();
    let sentCount = 0;

    for (const item of dueItems) {
      if (allowedUserIds.length > 0 && !allowedUserIds.includes(item.telegram_user_id)) {
        continue;
      }

      const typeLabel = item.type === "income" ? "pemasukan" : "pengeluaran";
      const message =
        `🔔 PENGINGAT TAGIHAN: ${item.name} [#${item.id}] sebesar ${formatRupiah(item.amount)} jatuh tempo hari ini! \n` +
        `Balas pesan ini dengan 'catat' untuk langsung memasukkannya ke ${typeLabel} bulan ini.`;

      try {
        await botInstance.api.sendMessage(item.telegram_user_id, message);
        markRecurringReminded(item.id, todayStr);
        sentCount++;
        logger.info(`Pengingat tagihan #${item.id} (${item.name}) berhasil dikirim ke user ${item.telegram_user_id}`);
      } catch (sendErr) {
        logger.error(`Gagal mengirim pengingat tagihan #${item.id} ke user ${item.telegram_user_id}:`, sendErr);
      }
    }

    return sentCount;
  } catch (err) {
    logger.error("Error pada checkRecurringReminders:", err);
    return 0;
  }
}

// Native scheduler for recurring reminders (every 6 hours, non-blocking)
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
let reminderTimer: NodeJS.Timeout | null = setInterval(() => {
  checkRecurringReminders(bot).catch((err) =>
    logger.error("Error saat menjalankan interval checkRecurringReminders:", err)
  );
}, SIX_HOURS_MS);

// Ensure setInterval does not block event loop
reminderTimer.unref();

// Handle graceful shutdown (SIGINT, SIGTERM from PM2/OS)
let isShuttingDown = false;

const gracefulShutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Menerima sinyal ${signal}. Memulai graceful shutdown...`);

  try {
    // 0. Clear recurring reminder interval timer
    if (reminderTimer) {
      clearInterval(reminderTimer);
      reminderTimer = null;
    }

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

    // Run recurring reminders check immediately upon startup
    try {
      const count = await checkRecurringReminders(bot);
      if (count > 0) {
        logger.info(`Berhasil mengirim ${count} pengingat tagihan saat startup.`);
      }
    } catch (reminderErr) {
      logger.error("Gagal memeriksa pengingat tagihan saat startup:", reminderErr);
    }
  },
});

