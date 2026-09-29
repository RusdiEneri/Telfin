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
  handleBackup,
  handleRestore,
  handleDocument,
  handleRekap,
  handlePhoto,
  handleCallbackQuery,
  handleTextMessage,
  handleDompet,
  handleSetDefault,
  handleTambahDompet,
  handleCari,
  handleExport,
  handleAnggaran,
  handleCekAnggaran,
} from "./handlers.js";

export const BOT_COMMANDS = [
  { command: "saldo", description: "Cek saldo & ringkasan dompet" },
  { command: "dompet", description: "Lihat daftar dompet & saldo" },
  { command: "setdefault", description: "Ubah dompet utama (<nama_dompet>)" },
  { command: "riwayat", description: "Lihat 5 transaksi terakhir & kelola" },
  { command: "cari", description: "Cari transaksi (<kata_kunci>)" },
  { command: "anggaran", description: "Set anggaran (<kategori> <nominal>)" },
  { command: "cekanggaran", description: "Cek pemakaian anggaran bulan ini" },
  { command: "rekap", description: "Ringkasan bulanan & kategori terbesar" },
  { command: "export", description: "Ekspor seluruh transaksi ke CSV" },
  { command: "expense", description: "Catat pengeluaran (<jumlah> <ket>)" },
  { command: "income", description: "Catat pemasukan (<jumlah> <ket>)" },
  { command: "edit", description: "Edit transaksi (<id> <nominal> <ket>)" },
  { command: "hapus", description: "Hapus transaksi (<id>)" },
  { command: "backup", description: "Unduh file backup database .db" },
  { command: "restore", description: "Pulihkan database dari file .db" },
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
  bot.command("dompet", handleDompet);
  bot.command("setdefault", handleSetDefault);
  bot.command("tambahdompet", handleTambahDompet);
  bot.command("riwayat", handleRiwayat);
  bot.command("cari", handleCari);
  bot.command("anggaran", handleAnggaran);
  bot.command("cekanggaran", handleCekAnggaran);
  bot.command("rekap", handleRekap);
  bot.command("export", handleExport);
  bot.command("help", handleHelp);
  bot.command("expense", handleExpense);
  bot.command("income", handleIncome);
  bot.command("hapus", handleHapus);
  bot.command("edit", handleEdit);
  bot.command("backup", handleBackup);
  bot.command("restore", handleRestore);

  bot.on(":photo", handlePhoto);
  bot.on("message:document", handleDocument);
  bot.on("callback_query:data", handleCallbackQuery);
  bot.on("message:text", handleTextMessage);

  return bot;
}