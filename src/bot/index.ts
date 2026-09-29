import { Bot } from "grammy";
import {
  handleStart,
  handleSaldo,
  handleRiwayat,
  handleHelp,
  handleExpense,
  handleIncome,
  handleHapus,
  handleEdit,
  handleRekap,
  handlePhoto,
  handleCallbackQuery,
  handleTextMessage,
} from "./handlers.js";

export const BOT_COMMANDS = [
  { command: "saldo", description: "Cek saldo & ringkasan dompet" },
  { command: "riwayat", description: "Lihat 5 transaksi terakhir & kelola" },
  { command: "rekap", description: "Ringkasan bulanan & kategori terbesar" },
  { command: "expense", description: "Catat pengeluaran (<jumlah> <ket>)" },
  { command: "income", description: "Catat pemasukan (<jumlah> <ket>)" },
  { command: "edit", description: "Edit transaksi (<id> <nominal> <ket>)" },
  { command: "hapus", description: "Hapus transaksi (<id>)" },
  { command: "help", description: "Panduan lengkap penggunaan bot" },
];

export function getAllowedUserIds(): string[] {
  const raw = process.env.ALLOWED_USER_IDS?.trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((id) => String(id).trim()).filter(Boolean);
    }
  } catch {
    return raw
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((s) => s.replace(/['"]/g, "").trim())
      .filter(Boolean);
  }

  return [];
}

export function createBot(token: string): Bot {
  const bot = new Bot(token);

  // Private bot access control: only allowed user IDs can interact
  bot.use(async (ctx, next) => {
    const allowedUserIds = getAllowedUserIds();
    if (allowedUserIds.length === 0) {
      return next();
    }

    const userId = ctx.from ? String(ctx.from.id) : null;
    if (!userId || !allowedUserIds.includes(userId)) {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "⛔ Akses ditolak. Bot ini bersifat pribadi." });
      } else if (ctx.chat) {
        await ctx.reply(
          "⛔ *Akses Ditolak*\n\nBot ini bersifat pribadi dan hanya dapat diakses oleh pemilik yang terdaftar.",
          { parse_mode: "Markdown" }
        );
      }
      return;
    }

    return next();
  });

  bot.command("start", handleStart);
  bot.command("saldo", handleSaldo);
  bot.command("riwayat", handleRiwayat);
  bot.command("rekap", handleRekap);
  bot.command("help", handleHelp);
  bot.command("expense", handleExpense);
  bot.command("income", handleIncome);
  bot.command("hapus", handleHapus);
  bot.command("edit", handleEdit);

  bot.on(":photo", handlePhoto);
  bot.on("callback_query:data", handleCallbackQuery);
  bot.on("message:text", handleTextMessage);

  return bot;
}