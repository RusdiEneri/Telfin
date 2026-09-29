import { InputFile, type Context } from "grammy";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import db, { initDb, dbPath, dataDir } from "../db/index.js";
import { formatRupiah, parseRupToInt } from "../utils/money.js";
import { logger } from "../utils/logger.js";
import {
  getOrCreateUserAndWallet,
  getUserWallets,
  getWalletById,
  setDefaultWallet,
  createWallet,
  updatePendingTransactionWallet,
  createPendingTransaction,
  createManualTransaction,
  confirmTransaction,
  cancelTransaction,
  softDeleteTransaction,
  updateTransaction,
  getTransactionById,
  getWalletBalance,
  getRecentTransactions,
  findConfirmedTransactionByHash,
  getMonthlyRecap,
  searchTransactions,
  getAllConfirmedTransactions,
  formatTransactionsCsv,
} from "../services/transaction.service.js";
import { saveUploadedBuffer, processReceiptFile } from "../services/receipt.service.js";
import {
  createTransactionConfirmationKeyboard,
  createTransactionActionKeyboard,
  createDeleteConfirmationKeyboard,
  createWalletSelectionKeyboard,
} from "./keyboards.js";

const MONTH_NAMES = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];

function getTelegramUser(ctx: Context) {
  const from = ctx.from;
  if (!from) throw new Error("Pengguna Telegram tidak ditemukan.");
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || "User";
  return { id: String(from.id), name };
}

export async function handleStart(ctx: Context) {
  const user = getTelegramUser(ctx);
  const { walletId } = getOrCreateUserAndWallet(user.id, user.name);
  const { balance } = getWalletBalance(walletId);

  const welcomeText =
    `👋 Halo, *${user.name}*!\n\n` +
    `Saya adalah bot pencatat keuangan otomatis dari foto nota / struk belanja 🧾.\n\n` +
    `💰 *Saldo Saat Ini*: ${formatRupiah(balance)}\n\n` +
    `📌 *Cara Penggunaan*:\n` +
    `1. Kirimkan foto nota/struk belanja Anda ke chat ini.\n` +
    `2. AI akan mengekstrak nominal, toko, kategori, dan detailnya.\n` +
    `3. Klik tombol *Konfirmasi* untuk memasukkan transaksi ke saldo.\n\n` +
    `⚙️ *Perintah yang Tersedia*:\n` +
    `• /dompet - Lihat daftar dompet & saldo\n` +
    `• /setdefault <nama_dompet> - Ubah dompet utama\n` +
    `• /expense <jumlah> <keterangan> - Catat pengeluaran manual\n` +
    `• /income <jumlah> <keterangan> - Catat pemasukan manual\n` +
    `• /rekap [MM-YYYY] - Ringkasan bulanan & kategori terbesar\n` +
    `• /saldo - Cek saldo dompet & ringkasan\n` +
    `• /riwayat - Lihat 5 transaksi terakhir\n` +
    `• /cari <kata_kunci> - Cari riwayat transaksi\n` +
    `• /edit <id> <jumlah> <keterangan> - Edit transaksi\n` +
    `• /hapus <id> - Hapus transaksi\n` +
    `• /export - Ekspor transaksi ke file CSV\n` +
    `• /backup - Unduh file backup database .db\n` +
    `• /restore - Pulihkan database dari file .db\n` +
    `• /help - Panduan lengkap`;

  await ctx.reply(welcomeText, { parse_mode: "Markdown" });
}

export async function handleExpense(ctx: Context) {
  const match = ctx.match as string | undefined;
  if (!match || !match.trim()) {
    await ctx.reply(
      "❌ Format salah.\n\nContoh penggunaan:\n`/expense 50000 makan siang`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const parts = match.trim().split(/\s+/);
  const amountStr = parts[0];
  const note = parts.slice(1).join(" ").trim();
  const amount = parseRupToInt(amountStr);

  if (!amount || !note) {
    await ctx.reply(
      "❌ Format salah.\n\nContoh penggunaan:\n`/expense 50000 makan siang`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const user = getTelegramUser(ctx);
  const { walletId } = getOrCreateUserAndWallet(user.id, user.name);

  createManualTransaction(walletId, "expense", amount, note);
  const { balance } = getWalletBalance(walletId);

  const replyText =
    `✅ *Pengeluaran Berhasil Dicatat!*\n\n` +
    `🔴 *Nominal*: ${formatRupiah(amount)}\n` +
    `📝 *Keterangan*: ${note}\n\n` +
    `💰 *Saldo Saat Ini*: *${formatRupiah(balance)}*`;

  await ctx.reply(replyText, { parse_mode: "Markdown" });
}

export async function handleIncome(ctx: Context) {
  const match = ctx.match as string | undefined;
  if (!match || !match.trim()) {
    await ctx.reply(
      "❌ Format salah.\n\nContoh penggunaan:\n`/income 1500000 gaji`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const parts = match.trim().split(/\s+/);
  const amountStr = parts[0];
  const note = parts.slice(1).join(" ").trim();
  const amount = parseRupToInt(amountStr);

  if (!amount || !note) {
    await ctx.reply(
      "❌ Format salah.\n\nContoh penggunaan:\n`/income 1500000 gaji`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const user = getTelegramUser(ctx);
  const { walletId } = getOrCreateUserAndWallet(user.id, user.name);

  createManualTransaction(walletId, "income", amount, note);
  const { balance } = getWalletBalance(walletId);

  const replyText =
    `✅ *Pemasukan Berhasil Dicatat!*\n\n` +
    `🟢 *Nominal*: ${formatRupiah(amount)}\n` +
    `📝 *Keterangan*: ${note}\n\n` +
    `💰 *Saldo Saat Ini*: *${formatRupiah(balance)}*`;

  await ctx.reply(replyText, { parse_mode: "Markdown" });
}

export async function handleRekap(ctx: Context) {
  const user = getTelegramUser(ctx);
  const { walletId } = getOrCreateUserAndWallet(user.id, user.name);

  const match = (ctx.match as string | undefined)?.trim();
  let year: number;
  let month: number;

  if (!match) {
    const now = new Date();
    year = now.getFullYear();
    month = now.getMonth() + 1;
  } else {
    // Support MM-YYYY or YYYY-MM
    const m1 = match.match(/^(\d{1,2})-(\d{4})$/);
    const m2 = match.match(/^(\d{4})-(\d{1,2})$/);
    if (m1) {
      month = parseInt(m1[1], 10);
      year = parseInt(m1[2], 10);
    } else if (m2) {
      year = parseInt(m2[1], 10);
      month = parseInt(m2[2], 10);
    } else {
      await ctx.reply(
        "❌ Format bulan salah.\n\nContoh penggunaan:\n• `/rekap` (bulan ini)\n• `/rekap 09-2026` (bulan tertentu)",
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (month < 1 || month > 12) {
      await ctx.reply("❌ Bulan tidak valid (harus 01 sampai 12).");
      return;
    }
  }

  const yearMonth = `${year}-${String(month).padStart(2, "0")}`;
  const monthName = MONTH_NAMES[month - 1];
  const recap = getMonthlyRecap(walletId, yearMonth);

  const sign = recap.netBalance >= 0 ? "+" : "-";
  const netFormatted = `${sign}${formatRupiah(Math.abs(recap.netBalance))}`;

  let text =
    `📊 *Rekap Keuangan - ${monthName} ${year}*\n\n` +
    `💰 *Total Pemasukan*: ${formatRupiah(recap.totalIncome)}\n` +
    `💸 *Total Pengeluaran*: ${formatRupiah(recap.totalExpense)}\n` +
    `📈 *Selisih (Net)*: *${netFormatted}*\n\n` +
    `🏆 *3 Kategori Pengeluaran Terbesar*:\n`;

  if (recap.topCategories.length === 0) {
    text += `_(Belum ada catatan pengeluaran di bulan ini)_\n`;
  } else {
    recap.topCategories.forEach((cat, idx) => {
      text += `${idx + 1}. *${cat.category}*: ${formatRupiah(cat.total)}\n`;
    });
  }

  await ctx.reply(text.trim(), { parse_mode: "Markdown" });
}

export async function handleSaldo(ctx: Context) {
  const user = getTelegramUser(ctx);
  const { walletId } = getOrCreateUserAndWallet(user.id, user.name);
  const { balance, totalIncome, totalExpense } = getWalletBalance(walletId);
  const currentWallet = getWalletById(walletId);

  const text =
    `📊 *Ringkasan Dompet: ${currentWallet?.name || "Utama"}*\n\n` +
    `💰 *Saldo*: ${formatRupiah(balance)}\n` +
    `📈 *Total Pemasukan*: ${formatRupiah(totalIncome)}\n` +
    `📉 *Total Pengeluaran*: ${formatRupiah(totalExpense)}\n\n` +
    `💡 _Ketik_ \`/dompet\` _untuk melihat semua dompet._`;

  await ctx.reply(text, { parse_mode: "Markdown" });
}

export function formatTransactionDetail(tx: {
  id: number;
  type: "income" | "expense";
  amount: number;
  merchant?: string | null;
  category?: string | null;
  note?: string | null;
  occurred_at?: string | null;
  created_at: string;
}): string {
  const icon = tx.type === "income" ? "🟢" : "🔴";
  const typeLabel = tx.type === "income" ? "Pemasukan" : "Pengeluaran";
  const date = tx.occurred_at || tx.created_at.slice(0, 10);

  const lines = [
    `${icon} *Transaksi [#${tx.id}] • ${typeLabel}*`,
    `💵 *Nominal*: *${formatRupiah(tx.amount)}*`,
  ];

  if (tx.merchant) lines.push(`🏪 *Merchant*: ${tx.merchant}`);
  if (tx.category) lines.push(`📂 *Kategori*: ${tx.category}`);
  lines.push(`📅 *Tanggal*: ${date}`);
  if (tx.note) lines.push(`📝 *Keterangan*: ${tx.note}`);

  return lines.join("\n");
}

export async function handleRiwayat(ctx: Context) {
  const user = getTelegramUser(ctx);
  const { walletId } = getOrCreateUserAndWallet(user.id, user.name);
  const transactions = getRecentTransactions(walletId, 5);

  if (transactions.length === 0) {
    await ctx.reply("Belum ada transaksi yang tersimpan. Kirim foto nota Anda untuk memulai!");
    return;
  }

  await ctx.reply("📜 *5 Transaksi Terakhir:*", { parse_mode: "Markdown" });

  for (const tx of transactions) {
    const text = formatTransactionDetail(tx);
    await ctx.reply(text, {
      parse_mode: "Markdown",
      reply_markup: createTransactionActionKeyboard(tx.id),
    });
  }
}

export async function handleHapus(ctx: Context) {
  const match = (ctx.match as string | undefined)?.trim();
  const id = match ? parseInt(match.replace(/^#/, ""), 10) : NaN;

  if (isNaN(id)) {
    await ctx.reply(
      "❌ Format salah.\n\nContoh penggunaan:\n`/hapus 12`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const user = getTelegramUser(ctx);
  const { userId } = getOrCreateUserAndWallet(user.id, user.name);
  const userWallets = getUserWallets(userId);
  const userWalletIds = new Set(userWallets.map((w) => w.id));
  const tx = getTransactionById(id);

  if (!tx || !userWalletIds.has(tx.wallet_id)) {
    await ctx.reply("❌ Transaksi tidak ditemukan atau bukan milik Anda.");
    return;
  }

  if (tx.status === "deleted") {
    await ctx.reply("⚠️ Transaksi ini sudah dihapus sebelumnya.");
    return;
  }

  softDeleteTransaction(id, tx.wallet_id);
  await ctx.reply("Transaksi berhasil dihapus. Saldo telah diperbarui.");
}

export async function handleEdit(ctx: Context) {
  const match = (ctx.match as string | undefined)?.trim();
  if (!match) {
    await ctx.reply(
      "❌ Format salah.\n\nContoh penggunaan:\n`/edit 12 75000 makan malam di warteg`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const parts = match.split(/\s+/);
  if (parts.length < 3) {
    await ctx.reply(
      "❌ Format salah.\n\nContoh penggunaan:\n`/edit 12 75000 makan malam di warteg`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const id = parseInt(parts[0].replace(/^#/, ""), 10);
  const amount = parseRupToInt(parts[1]);
  const note = parts.slice(2).join(" ").trim();

  if (isNaN(id) || !amount || !note) {
    await ctx.reply(
      "❌ Format salah.\n\nContoh penggunaan:\n`/edit 12 75000 makan malam di warteg`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const user = getTelegramUser(ctx);
  const { userId } = getOrCreateUserAndWallet(user.id, user.name);
  const userWallets = getUserWallets(userId);
  const userWalletIds = new Set(userWallets.map((w) => w.id));
  const tx = getTransactionById(id);

  if (!tx || !userWalletIds.has(tx.wallet_id)) {
    await ctx.reply("❌ Transaksi tidak ditemukan atau bukan milik Anda.");
    return;
  }

  if (tx.status !== "confirmed") {
    await ctx.reply("❌ Hanya transaksi yang sudah dikonfirmasi yang dapat diedit.");
    return;
  }

  updateTransaction(id, tx.wallet_id, amount, note);
  await ctx.reply("Transaksi berhasil diperbarui. Saldo telah diperbarui.");
}

export async function handleTextMessage(ctx: Context) {
  const message = ctx.message;
  const replyTo = message?.reply_to_message;
  if (!message || !replyTo?.text) return;

  if (!replyTo.text.includes("Silakan balas pesan ini dengan format: <nominal_baru> <keterangan_baru>")) {
    return;
  }

  const match = replyTo.text.match(/#(\d+)/);
  if (!match) return;
  const txId = parseInt(match[1], 10);

  const text = ctx.message.text?.trim() || "";
  const parts = text.split(/\s+/);
  const amount = parseRupToInt(parts[0]);
  const note = parts.slice(1).join(" ").trim();

  if (!amount || !note) {
    await ctx.reply(
      "❌ Format salah.\n\nSilakan balas dengan format: `<nominal_baru> <keterangan_baru>`\nContoh: `75000 makan malam di warteg`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const user = getTelegramUser(ctx);
  const { userId } = getOrCreateUserAndWallet(user.id, user.name);
  const userWallets = getUserWallets(userId);
  const userWalletIds = new Set(userWallets.map((w) => w.id));
  const tx = getTransactionById(txId);

  if (!tx || !userWalletIds.has(tx.wallet_id)) {
    await ctx.reply("❌ Transaksi tidak ditemukan atau bukan milik Anda.");
    return;
  }

  if (tx.status !== "confirmed") {
    await ctx.reply("❌ Hanya transaksi yang sudah dikonfirmasi yang dapat diedit.");
    return;
  }

  updateTransaction(txId, tx.wallet_id, amount, note);
  await ctx.reply("Transaksi berhasil diperbarui. Saldo telah diperbarui.");
}

export async function handleHelp(ctx: Context) {
  const helpText =
    `📖 *Panduan Penggunaan Bot*\n\n` +
    `1. *Kirim Foto Nota*: Foto nota Anda, kirim ke chat ini. AI akan mengekstrak nominal secara otomatis.\n` +
    `2. *Konfirmasi Transaksi*: Transaksi dari nota berstatus *pending*. Klik '✅ Konfirmasi' agar masuk ke saldo.\n` +
    `3. *Batalkan*: Klik '❌ Batalkan' jika data salah atau nota tidak ingin dicatat.\n` +
    `4. *Input Manual*: Catat transaksi tanpa foto dengan perintah manual.\n\n` +
    `*Daftar Perintah*:\n` +
    `• /dompet - Melihat daftar dompet dan saldo masing-masing\n` +
    `• /setdefault <nama_dompet> - Mengatur dompet default / utama\n` +
    `• /tambahdompet <nama_dompet> - Menambahkan dompet baru\n` +
    `• /expense <jumlah> <keterangan> - Catat pengeluaran manual (contoh: /expense 50000 makan siang)\n` +
    `• /income <jumlah> <keterangan> - Catat pemasukan manual (contoh: /income 1500000 gaji)\n` +
    `• /rekap [MM-YYYY] - Ringkasan keuangan bulanan & top kategori (contoh: /rekap 09-2026)\n` +
    `• /saldo - Menampilkan sisa saldo dan ringkasan dompet\n` +
    `• /riwayat - Melihat daftar riwayat 5 transaksi terakhir\n` +
    `• /cari <kata_kunci> - Cari transaksi berdasarkan merchant/keterangan (contoh: /cari indomaret)\n` +
    `• /edit <id> <jumlah> <keterangan> - Edit transaksi (contoh: /edit 12 75000 makan malam)\n` +
    `• /hapus <id> - Hapus transaksi berdasarkan ID (contoh: /hapus 12)\n` +
    `• /export - Ekspor seluruh riwayat transaksi ke file .csv\n` +
    `• /backup - Unduh file backup database .db\n` +
    `• /restore - Pulihkan database dari file backup .db\n` +
    `• /help - Menampilkan pesan panduan ini`;

  await ctx.reply(helpText, { parse_mode: "Markdown" });
}

export async function handleDompet(ctx: Context) {
  const user = getTelegramUser(ctx);
  const { userId } = getOrCreateUserAndWallet(user.id, user.name);
  const wallets = getUserWallets(userId);

  let text = `💳 *Daftar Dompet Anda*:\n\n`;
  for (const w of wallets) {
    const { balance } = getWalletBalance(w.id);
    const defaultBadge = w.is_default ? " ⭐ *(Utama)*" : "";
    text += `• *${w.name}*${defaultBadge}\n  Saldo: ${formatRupiah(balance)}\n`;
  }
  text += `\n💡 _Gunakan_ \`/setdefault <nama_dompet>\` _untuk mengubah dompet utama._`;
  text += `\n💡 _Gunakan_ \`/tambahdompet <nama_dompet>\` _untuk menambah dompet baru._`;

  await ctx.reply(text, { parse_mode: "Markdown" });
}

export async function handleSetDefault(ctx: Context) {
  const match = ctx.match as string | undefined;
  if (!match || !match.trim()) {
    await ctx.reply(
      "❌ Format salah.\n\nContoh penggunaan:\n`/setdefault Dompet Utama`\n`/setdefault Bank BCA`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const user = getTelegramUser(ctx);
  const { userId } = getOrCreateUserAndWallet(user.id, user.name);
  const walletName = match.trim();

  const result = setDefaultWallet(userId, walletName);
  if (!result.success || !result.wallet) {
    await ctx.reply(
      `❌ Dompet "${walletName}" tidak ditemukan. Cek daftar dompet Anda dengan /dompet.`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  await ctx.reply(
    `✅ Dompet *${result.wallet.name}* berhasil disetel sebagai dompet utama (default).`,
    { parse_mode: "Markdown" }
  );
}

export async function handleTambahDompet(ctx: Context) {
  const match = ctx.match as string | undefined;
  if (!match || !match.trim()) {
    await ctx.reply(
      "❌ Format salah.\n\nContoh penggunaan:\n`/tambahdompet Bank BCA`\n`/tambahdompet Gopay`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const user = getTelegramUser(ctx);
  const { userId } = getOrCreateUserAndWallet(user.id, user.name);
  const walletName = match.trim();

  const existing = getUserWallets(userId).find(
    (w) => w.name.toLowerCase() === walletName.toLowerCase()
  );
  if (existing) {
    await ctx.reply(`⚠️ Dompet dengan nama *${walletName}* sudah ada.`, {
      parse_mode: "Markdown",
    });
    return;
  }

  const newWallet = createWallet(userId, walletName);
  await ctx.reply(
    `✅ Dompet *${newWallet.name}* berhasil dibuat.\n\nKetik /dompet untuk melihat daftar dompet.`,
    { parse_mode: "Markdown" }
  );
}

export async function handleCari(ctx: Context) {
  const match = (ctx.match as string | undefined)?.trim();
  if (!match) {
    await ctx.reply(
      "❌ Format salah.\n\nContoh penggunaan:\n`/cari indomaret`\n`/cari bensin`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const user = getTelegramUser(ctx);
  const { userId } = getOrCreateUserAndWallet(user.id, user.name);

  const results = searchTransactions(userId, match, 10);
  if (results.length === 0) {
    await ctx.reply("🔍 Tidak ditemukan transaksi dengan kata kunci tersebut.");
    return;
  }

  let text = `🔍 *Hasil Pencarian: "${match}"*\n\n`;
  for (const tx of results) {
    const date = tx.occurred_at || tx.created_at.slice(0, 10);
    const merchant = tx.merchant || tx.note || "-";
    text += `[#${tx.id}] ${date} | ${merchant} | ${formatRupiah(tx.amount)}\n`;
  }

  await ctx.reply(text.trim(), { parse_mode: "Markdown" });
}

export async function handleExport(ctx: Context) {
  try {
    const user = getTelegramUser(ctx);
    const { userId } = getOrCreateUserAndWallet(user.id, user.name);

    const transactions = getAllConfirmedTransactions(userId);
    if (transactions.length === 0) {
      await ctx.reply("⚠️ Belum ada transaksi yang berstatus confirmed untuk diekspor.");
      return;
    }

    const csvString = formatTransactionsCsv(transactions);
    const buffer = Buffer.from(csvString, "utf-8");
    const dateStr = new Date().toISOString().slice(0, 10);
    const fileName = `export_telfin_${dateStr}.csv`;

    await ctx.replyWithDocument(new InputFile(buffer, fileName), {
      caption: `✅ Berhasil mengekspor ${transactions.length} transaksi ke file CSV.`,
    });
  } catch (err: any) {
    logger.error("Gagal melakukan export transaksi:", err);
    await ctx.reply("❌ Gagal mengekspor transaksi.");
  }
}

export async function handleBackup(ctx: Context) {
  try {
    // Checkpoint SQLite WAL so bot.db has all latest transactions
    db.pragma("wal_checkpoint(TRUNCATE)");

    const buffer = await fs.promises.readFile(dbPath);
    const dateStr = new Date().toISOString().slice(0, 10);
    const fileName = `telfin_backup_${dateStr}.db`;

    await ctx.replyWithDocument(new InputFile(buffer, fileName), {
      caption: "✅ Backup database berhasil dikirim. Simpan file ini di tempat aman.",
    });
  } catch (err: any) {
    logger.error("Gagal melakukan backup database:", err);
    await ctx.reply("❌ Gagal membuat backup database.");
  }
}

export async function handleRestore(ctx: Context) {
  const replyTo = ctx.message?.reply_to_message;
  const doc = replyTo?.document;

  if (doc) {
    return processRestoreDocument(ctx, doc);
  }

  await ctx.reply("⚠️ Silakan balas pesan ini dengan mengunggah file backup .db Anda.", {
    reply_markup: { force_reply: true },
  });
}

export async function handleDocument(ctx: Context) {
  const message = ctx.message;
  const doc = message?.document;
  if (!doc) return;

  const replyTo = message.reply_to_message;
  const isReplyToRestorePrompt = replyTo?.text?.includes("Silakan balas pesan ini dengan mengunggah file backup .db Anda");
  const hasRestoreCaption = message.caption?.trim() === "/restore";

  if (!isReplyToRestorePrompt && !hasRestoreCaption) {
    return;
  }

  return processRestoreDocument(ctx, doc);
}

async function processRestoreDocument(ctx: Context, doc: any) {
  const fileName = (doc.file_name || "").toLowerCase();
  const mimeType = (doc.mime_type || "").toLowerCase();
  const isDb = fileName.endsWith(".db") || mimeType === "application/x-sqlite3" || mimeType === "application/vnd.sqlite3";

  if (!isDb) {
    await ctx.reply("❌ File tidak valid. Harap unggah file backup dengan ekstensi `.db`.", {
      parse_mode: "Markdown",
    });
    return;
  }

  const statusMsg = await ctx.reply("⏳ _Memproses pemulihan database..._", {
    parse_mode: "Markdown",
  });

  try {
    const file = await ctx.getFile();
    if (!file.file_path) {
      throw new Error("File path dari Telegram tidak tersedia.");
    }

    const botToken = process.env.BOT_TOKEN;
    const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
    const res = await fetch(downloadUrl);
    if (!res.ok) {
      throw new Error(`Gagal mengunduh file (${res.status})`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());

    // Validate SQLite magic header: must begin with "SQLite format 3"
    if (buffer.length < 16 || buffer.subarray(0, 15).toString() !== "SQLite format 3") {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        "❌ File bukan database SQLite yang valid."
      );
      return;
    }

    // 1. Close current DB connection
    db.close();

    // 2. Overwrite data/bot.db asynchronously
    await fs.promises.writeFile(dbPath, buffer);

    // 3. Remove stale WAL and SHM files if any
    const walPath = path.join(dataDir, "bot.db-wal");
    const shmPath = path.join(dataDir, "bot.db-shm");
    if (fs.existsSync(walPath)) await fs.promises.unlink(walPath).catch(() => {});
    if (fs.existsSync(shmPath)) await fs.promises.unlink(shmPath).catch(() => {});

    // 4. Reopen and re-initialize SQLite
    initDb();

    await ctx.api.editMessageText(
      ctx.chat!.id,
      statusMsg.message_id,
      "✅ Database berhasil dipulihkan. Bot telah di-reload."
    );
  } catch (err: any) {
    logger.error("Gagal memulihkan database:", err);
    try {
      initDb();
    } catch (_) {}

    await ctx.api.editMessageText(
      ctx.chat!.id,
      statusMsg.message_id,
      "❌ Terjadi kesalahan saat memulihkan database. Silakan coba lagi."
    );
  }
}

export function formatReceiptPreview(
  tx: {
    type: string;
    amount: number;
    merchant?: string | null;
    category?: string | null;
    occurred_at?: string | null;
    note?: string | null;
  },
  walletName: string
): string {
  const typeLabel = tx.type === "income" ? "🟢 Pemasukan" : "🔴 Pengeluaran";
  return (
    `🧾 *Preview Transaksi Nota*\n\n` +
    `🏷️ *Tipe*: ${typeLabel}\n` +
    `💵 *Nominal*: *${formatRupiah(tx.amount)}*\n` +
    `🏪 *Merchant*: ${tx.merchant || "-"}\n` +
    `📂 *Kategori*: ${tx.category || "-"}\n` +
    `📅 *Tanggal*: ${tx.occurred_at || "-"}\n` +
    (tx.note ? `📝 *Catatan*: _${tx.note}_\n` : "") +
    `Akan dicatat ke: 💳 *${walletName}*\n\n` +
    `⚠️ *Status: Menunggu Konfirmasi*\n` +
    `Klik tombol di bawah untuk menyimpan transaksi ke saldo Anda.`
  );
}

export async function handlePhoto(ctx: Context) {
  const user = getTelegramUser(ctx);
  const { walletId } = getOrCreateUserAndWallet(user.id, user.name);

  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0) {
    await ctx.reply("Foto tidak terdeteksi. Silakan kirim ulang foto nota.");
    return;
  }

  const statusMsg = await ctx.reply("⏳ _Sedang mengunduh foto & membaca nota dengan AI..._", {
    parse_mode: "Markdown",
  });

  let localPath: string | null = null;

  try {
    const file = await ctx.getFile();
    if (!file.file_path) {
      throw new Error("File path dari Telegram tidak tersedia.");
    }

    const botToken = process.env.BOT_TOKEN;
    const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
    const res = await fetch(downloadUrl);
    if (!res.ok) {
      throw new Error(`Gagal mengunduh gambar dari Telegram (${res.status})`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());

    // 1. Anti-Double Input: check SHA-256 hash before running AI
    const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");
    const existingConfirmed = findConfirmedTransactionByHash(walletId, fileHash);

    if (existingConfirmed) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        "⚠️ Nota ini sudah pernah dicatat sebelumnya. Transaksi dibatalkan."
      );
      return;
    }

    const ext = path.extname(file.file_path) || ".jpg";
    localPath = saveUploadedBuffer(buffer, ext);

    const extraction = await processReceiptFile(localPath);

    // Validate that extraction has a valid positive amount
    if (!extraction || !extraction.amount || extraction.amount <= 0) {
      throw new Error("Total pada nota tidak terdeteksi atau tidak valid.");
    }

    // Save as pending transaction with fileHash recorded
    const txId = createPendingTransaction(walletId, extraction, localPath, fileHash);

    const defaultWallet = getWalletById(walletId);
    const walletName = defaultWallet ? defaultWallet.name : "Dompet Utama";
    const previewText = formatReceiptPreview(extraction, walletName);

    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, previewText, {
      parse_mode: "Markdown",
      reply_markup: createTransactionConfirmationKeyboard(txId),
    });
  } catch (error: any) {
    logger.error("Error processing receipt photo:", error);

    // Clean up uploaded file if processing failed so it doesn't leave junk
    if (localPath && fs.existsSync(localPath)) {
      try {
        fs.unlinkSync(localPath);
        logger.info(`File nota gagal dibersihkan: ${localPath}`);
      } catch (unlinkErr) {
        logger.error("Gagal menghapus file nota gagal:", unlinkErr);
      }
    }

    const isServerError =
      error?.message?.includes("503") ||
      error?.message?.includes("Gemini") ||
      error?.message?.includes("OpenAI") ||
      error?.message?.includes("fetch");

    const errorMsg = isServerError
      ? "Layanan AI sedang mengalami gangguan atau beban tinggi. Silakan coba kirim ulang beberapa saat lagi, atau catat manual dengan: /expense [jumlah] [keterangan]"
      : "Maaf, saya tidak bisa membaca total di nota ini. Pastikan foto tidak blur, tidak terpotong, dan terlihat jelas. Atau kamu bisa input manual dengan mengetik: /expense [jumlah] [keterangan]";

    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, errorMsg);
  }
}

export async function handleCallbackQuery(ctx: Context) {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const user = getTelegramUser(ctx);
  const { userId } = getOrCreateUserAndWallet(user.id, user.name);
  const userWallets = getUserWallets(userId);
  const userWalletIds = new Set(userWallets.map((w) => w.id));

  // 1. Flow Hapus: delete_<id>
  if (data.startsWith("delete_")) {
    const txId = parseInt(data.slice("delete_".length), 10);
    if (isNaN(txId)) {
      await ctx.answerCallbackQuery({ text: "ID Transaksi tidak valid." });
      return;
    }

    const tx = getTransactionById(txId);
    if (!tx || !userWalletIds.has(tx.wallet_id)) {
      await ctx.answerCallbackQuery({ text: "Transaksi tidak ditemukan atau bukan milik Anda." });
      return;
    }

    const desc = tx.merchant || tx.note || "Transaksi";
    const confirmText = `Yakin ingin menghapus transaksi ${desc} sebesar ${formatRupiah(tx.amount)}?`;
    await ctx.editMessageText(confirmText, {
      reply_markup: createDeleteConfirmationKeyboard(txId),
    });
    await ctx.answerCallbackQuery();
    return;
  }

  // 2. Flow Konfirmasi Hapus: confirm_delete_<id>
  if (data.startsWith("confirm_delete_")) {
    const txId = parseInt(data.slice("confirm_delete_".length), 10);
    if (isNaN(txId)) {
      await ctx.answerCallbackQuery({ text: "ID Transaksi tidak valid." });
      return;
    }

    const tx = getTransactionById(txId);
    if (!tx || !userWalletIds.has(tx.wallet_id)) {
      await ctx.answerCallbackQuery({ text: "Transaksi tidak ditemukan atau bukan milik Anda." });
      return;
    }

    softDeleteTransaction(txId, tx.wallet_id);
    await ctx.editMessageText("Transaksi berhasil dihapus. Saldo telah diperbarui.");
    await ctx.answerCallbackQuery({ text: "Transaksi berhasil dihapus." });
    return;
  }

  // 3. Flow Batal Hapus: cancel_delete_<id>
  if (data.startsWith("cancel_delete_")) {
    const txId = parseInt(data.slice("cancel_delete_".length), 10);
    if (isNaN(txId)) {
      await ctx.answerCallbackQuery({ text: "ID Transaksi tidak valid." });
      return;
    }

    const tx = getTransactionById(txId);
    if (!tx || !userWalletIds.has(tx.wallet_id)) {
      await ctx.answerCallbackQuery({ text: "Transaksi tidak ditemukan atau bukan milik Anda." });
      return;
    }

    const text = formatTransactionDetail(tx);
    await ctx.editMessageText(text, {
      parse_mode: "Markdown",
      reply_markup: createTransactionActionKeyboard(tx.id),
    });
    await ctx.answerCallbackQuery({ text: "Penghapusan dibatalkan." });
    return;
  }

  // 4. Flow Edit: edit_<id>
  if (data.startsWith("edit_")) {
    const txId = parseInt(data.slice("edit_".length), 10);
    if (isNaN(txId)) {
      await ctx.answerCallbackQuery({ text: "ID Transaksi tidak valid." });
      return;
    }

    const tx = getTransactionById(txId);
    if (!tx || !userWalletIds.has(tx.wallet_id)) {
      await ctx.answerCallbackQuery({ text: "Transaksi tidak ditemukan atau bukan milik Anda." });
      return;
    }

    await ctx.reply(
      `Silakan balas pesan ini dengan format: <nominal_baru> <keterangan_baru>. Contoh: 75000 makan malam di warteg\n\n(Edit transaksi #${txId})`,
      {
        reply_markup: {
          force_reply: true,
          selective: true,
        },
      }
    );
    await ctx.answerCallbackQuery();
    return;
  }

  // 5. Flow Ubah Dompet Nota Pending: change_wallet_<pending_id>
  if (data.startsWith("change_wallet_")) {
    const pendingId = parseInt(data.slice("change_wallet_".length), 10);
    if (isNaN(pendingId)) {
      await ctx.answerCallbackQuery({ text: "ID Transaksi tidak valid." });
      return;
    }

    const tx = getTransactionById(pendingId);
    if (!tx || !userWalletIds.has(tx.wallet_id)) {
      await ctx.answerCallbackQuery({ text: "Transaksi tidak ditemukan atau bukan milik Anda." });
      return;
    }

    if (tx.status !== "pending") {
      await ctx.answerCallbackQuery({ text: `Transaksi ini sudah ${tx.status}.` });
      return;
    }

    await ctx.editMessageText(
      `💳 *Pilih Dompet*\n\nSilakan pilih dompet yang akan digunakan untuk mencatat transaksi *${formatRupiah(tx.amount)}*:`,
      {
        parse_mode: "Markdown",
        reply_markup: createWalletSelectionKeyboard(pendingId, userWallets, tx.wallet_id),
      }
    );
    await ctx.answerCallbackQuery();
    return;
  }

  // 6. Flow Set Dompet Baru: set_wallet_<pending_id>_<wallet_id>
  if (data.startsWith("set_wallet_")) {
    const rest = data.slice("set_wallet_".length);
    const parts = rest.split("_");
    const pendingId = parseInt(parts[0], 10);
    const newWalletId = parseInt(parts[1], 10);

    if (isNaN(pendingId) || isNaN(newWalletId)) {
      await ctx.answerCallbackQuery({ text: "Data tidak valid." });
      return;
    }

    if (!userWalletIds.has(newWalletId)) {
      await ctx.answerCallbackQuery({ text: "Dompet tidak ditemukan atau bukan milik Anda." });
      return;
    }

    const tx = getTransactionById(pendingId);
    if (!tx || !userWalletIds.has(tx.wallet_id)) {
      await ctx.answerCallbackQuery({ text: "Transaksi tidak ditemukan atau bukan milik Anda." });
      return;
    }

    if (tx.status !== "pending") {
      await ctx.answerCallbackQuery({ text: `Transaksi ini sudah ${tx.status}.` });
      return;
    }

    updatePendingTransactionWallet(pendingId, newWalletId);
    const targetWallet = getWalletById(newWalletId);
    const walletName = targetWallet ? targetWallet.name : "Dompet";

    const previewText = formatReceiptPreview(tx, walletName);
    await ctx.editMessageText(previewText, {
      parse_mode: "Markdown",
      reply_markup: createTransactionConfirmationKeyboard(pendingId),
    });
    await ctx.answerCallbackQuery({ text: `Dompet diubah ke: ${walletName}` });
    return;
  }

  // 7. Flow Kembali ke Preview: back_preview_<pending_id>
  if (data.startsWith("back_preview_")) {
    const pendingId = parseInt(data.slice("back_preview_".length), 10);
    if (isNaN(pendingId)) {
      await ctx.answerCallbackQuery({ text: "ID Transaksi tidak valid." });
      return;
    }

    const tx = getTransactionById(pendingId);
    if (!tx || !userWalletIds.has(tx.wallet_id)) {
      await ctx.answerCallbackQuery({ text: "Transaksi tidak ditemukan atau bukan milik Anda." });
      return;
    }

    const currentWallet = getWalletById(tx.wallet_id);
    const walletName = currentWallet ? currentWallet.name : "Dompet Utama";
    const previewText = formatReceiptPreview(tx, walletName);

    await ctx.editMessageText(previewText, {
      parse_mode: "Markdown",
      reply_markup: createTransactionConfirmationKeyboard(pendingId),
    });
    await ctx.answerCallbackQuery();
    return;
  }

  // 8. Flow Konfirmasi / Batalkan Nota: confirm:<id> / cancel:<id>
  const [action, idStr] = data.split(":");
  const transactionId = parseInt(idStr, 10);

  if (isNaN(transactionId)) {
    await ctx.answerCallbackQuery({ text: "ID Transaksi tidak valid." });
    return;
  }

  const tx = getTransactionById(transactionId);

  if (!tx || !userWalletIds.has(tx.wallet_id)) {
    await ctx.answerCallbackQuery({ text: "Transaksi tidak ditemukan atau bukan milik Anda." });
    return;
  }

  if (tx.status !== "pending") {
    await ctx.answerCallbackQuery({ text: `Transaksi ini sudah ${tx.status}.` });
    return;
  }

  if (action === "confirm") {
    confirmTransaction(transactionId, tx.wallet_id);
    const { balance } = getWalletBalance(tx.wallet_id);
    const targetWallet = getWalletById(tx.wallet_id);

    const typeIcon = tx.type === "income" ? "🟢" : "🔴";
    const resultText =
      `✅ *Transaksi Berhasil Disimpan!*\n\n` +
      `${typeIcon} *Nominal*: ${formatRupiah(tx.amount)}\n` +
      `🏪 *Merchant*: ${tx.merchant || "-"}\n` +
      `📂 *Kategori*: ${tx.category || "-"}\n` +
      `📅 *Tanggal*: ${tx.occurred_at || "-"}\n` +
      `💳 *Dompet*: ${targetWallet?.name || "Dompet Utama"}\n\n` +
      `💰 *Saldo Dompet Saat Ini*: *${formatRupiah(balance)}*`;

    await ctx.editMessageText(resultText, { parse_mode: "Markdown" });
    await ctx.answerCallbackQuery({ text: "Transaksi berhasil dikonfirmasi!" });
  } else if (action === "cancel") {
    cancelTransaction(transactionId, tx.wallet_id);

    const resultText =
      `❌ *Transaksi Dibatalkan*\n\n` +
      `Nominal *${formatRupiah(tx.amount)}* tidak dimasukkan ke dalam saldo.`;

    await ctx.editMessageText(resultText, { parse_mode: "Markdown" });
    await ctx.answerCallbackQuery({ text: "Transaksi dibatalkan." });
  }
}
