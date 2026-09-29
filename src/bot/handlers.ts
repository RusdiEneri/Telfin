import { InputFile, type Context } from "grammy";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import db, { initDb, dbPath, dataDir } from "../db/index.js";
import { formatRupiah, parseRupToInt, generateBarChart, getCategoryEmoji } from "../utils/money.js";
import { formatDateTimeJakarta, getCurrentYearMonthJakarta, getTodayDateJakarta, getTodayDayJakarta } from "../utils/date.js";
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
  setBudget,
  getBudgetReport,
  checkBudgetWarning,
  getUserRecurrings,
  createRecurring,
  deactivateRecurring,
  getRecurringById,
  recordTransactionFromRecurring,
  findActiveRecurringByName,
  markRecurringReminded,
  parseCsvTransactions,
  importTransactionsBulk,
  buildFinancialRecapSummary,
} from "../services/transaction.service.js";
import { saveUploadedBuffer, processReceiptFile } from "../services/receipt.service.js";
import { generateFinancialInsight } from "../services/ai.service.js";
import {
  createTransactionConfirmationKeyboard,
  createTransactionActionKeyboard,
  createDeleteConfirmationKeyboard,
  createWalletSelectionKeyboard,
  createImportConfirmationKeyboard,
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

// ponytail: in-memory map for rate limiting (1x per 24 hours per user). Upgradable to SQLite table if persistence across bot restarts is needed.
const userLastInsight = new Map<number, number>();
const INSIGHT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export function checkInsightRateLimit(userId: number | string): { allowed: boolean; remainingHours?: number } {
  const uId = Number(userId);
  const lastTime = userLastInsight.get(uId);
  if (!lastTime) return { allowed: true };
  const diff = Date.now() - lastTime;
  if (diff < INSIGHT_COOLDOWN_MS) {
    const remainingHours = Math.max(1, Math.ceil((INSIGHT_COOLDOWN_MS - diff) / (60 * 60 * 1000)));
    return { allowed: false, remainingHours };
  }
  return { allowed: true };
}

export function recordInsightUsage(userId: number | string): void {
  userLastInsight.set(Number(userId), Date.now());
}

export function resetInsightRateLimit(userId?: number | string): void {
  if (userId !== undefined) {
    userLastInsight.delete(Number(userId));
  } else {
    userLastInsight.clear();
  }
}

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
    `Selamat datang di *Telfin*, asisten pintar pencatat keuangan pribadi Anda 🧾✨\n\n` +
    `💰 *Saldo Dompet Saat Ini*: *${formatRupiah(balance)}*\n\n` +
    `📸 *Cara Paling Praktis:*\n` +
    `Cukup *kirimkan foto nota/struk belanja* ke chat ini! AI akan otomatis membaca nominal belanja, toko, dan tanggalnya.\n\n` +
    `✏️ *Catat Manual Cepat*:\n` +
    `• Pengeluaran: \`/expense 25000 makan siang\`\n` +
    `• Pemasukan: \`/income 1500000 gaji bulanan\`\n\n` +
    `📊 *Pantau Keuangan*:\n` +
    `• \`/saldo\` — Cek sisa saldo & uang keluar/masuk\n` +
    `• \`/riwayat\` — Lihat 5 transaksi terakhir\n` +
    `• \`/rekap\` — Laporan & grafik pengeluaran bulanan\n` +
    `• \`/insight\` — Analisa & saran keuangan bulanan AI\n\n` +
    `⚙️ *Fitur Lainnya*:\n` +
    `• \`/anggaran\` — Pasang batas belanja agar tidak boros\n` +
    `• \`/langganan\` — Pengingat tagihan rutin (kos/Netflix/dll)\n` +
    `• \`/dompet\` — Kelola dompet (Cash, Bank, e-Wallet)\n` +
    `• \`/help\` — Panduan lengkap semua perintah`;

  await ctx.reply(welcomeText, { parse_mode: "Markdown" });
}

export async function handleExpense(ctx: Context) {
  const match = ctx.match as string | undefined;
  if (!match || !match.trim()) {
    await ctx.reply(
      "💡 *Cara Mencatat Pengeluaran:*\n\n" +
      "Ketik nominal belanja diikuti keterangannya.\n\n" +
      "*Format*: `/expense <nominal> <keterangan>`\n" +
      "*Contoh*:\n" +
      "• `/expense 50000 makan siang`\n" +
      "• `/expense 25.000 kopi susu`\n" +
      "• `/expense 150k bensin motor`",
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
      "💡 *Keterangan belanja belum diisi.*\n\n" +
      "Ketik nominal belanja dan keterangannya.\n" +
      "*Contoh*: `/expense 50000 makan siang`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const user = getTelegramUser(ctx);
  const { walletId } = getOrCreateUserAndWallet(user.id, user.name);

  createManualTransaction(walletId, "expense", amount, note);
  const { balance } = getWalletBalance(walletId);
  const defaultWallet = getWalletById(walletId);

  let replyText =
    `✅ *Pengeluaran Berhasil Dicatat!*\n\n` +
    `🔴 *Nominal*: ${formatRupiah(amount)}\n` +
    `📝 *Keterangan*: ${note}\n` +
    `📅 *Waktu*: ${formatDateTimeJakarta(new Date())}\n` +
    `💳 *Dompet*: ${defaultWallet?.name || "Dompet Utama"}\n\n` +
    `💰 *Sisa Saldo*: *${formatRupiah(balance)}*`;

  const budgetWarning = checkBudgetWarning(walletId, note, amount, getCurrentYearMonthJakarta());
  if (budgetWarning.isOverbudget && budgetWarning.category) {
    replyText += `\n\n⚠️ *PERINGATAN*: Pengeluaran ini telah melebihi batas anggaran kategori *${budgetWarning.category}*!`;
  }

  await ctx.reply(replyText, { parse_mode: "Markdown" });
}

export async function handleIncome(ctx: Context) {
  const match = ctx.match as string | undefined;
  if (!match || !match.trim()) {
    await ctx.reply(
      "💡 *Cara Mencatat Pemasukan:*\n\n" +
      "Ketik nominal uang masuk diikuti sumbernya.\n\n" +
      "*Format*: `/income <nominal> <sumber/keterangan>`\n" +
      "*Contoh*:\n" +
      "• `/income 1500000 gaji bulanan`\n" +
      "• `/income 200.000 transfer teman`\n" +
      "• `/income 500k penjualan online`",
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
      "💡 *Sumber pemasukan belum diisi.*\n\n" +
      "Ketik nominal uang masuk dan sumbernya.\n" +
      "*Contoh*: `/income 1500000 gaji bulanan`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const user = getTelegramUser(ctx);
  const { walletId } = getOrCreateUserAndWallet(user.id, user.name);

  createManualTransaction(walletId, "income", amount, note);
  const { balance } = getWalletBalance(walletId);
  const defaultWallet = getWalletById(walletId);

  const replyText =
    `✅ *Pemasukan Berhasil Dicatat!*\n\n` +
    `🟢 *Nominal*: ${formatRupiah(amount)}\n` +
    `📝 *Keterangan*: ${note}\n` +
    `📅 *Waktu*: ${formatDateTimeJakarta(new Date())}\n` +
    `💳 *Dompet*: ${defaultWallet?.name || "Dompet Utama"}\n\n` +
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
    `📊 *Distribusi Pengeluaran per Kategori*:\n`;

  if (recap.topCategories.length === 0) {
    text += `_(Belum ada catatan pengeluaran di bulan ini)_\n`;
  } else {
    for (const cat of recap.topCategories) {
      const emoji = getCategoryEmoji(cat.category);
      const bar = generateBarChart(cat.percentage);
      text += `${emoji} *${cat.category}*  ${bar} ${cat.percentage}% (${formatRupiah(cat.total)})\n`;
    }
  }

  await ctx.reply(text.trim(), { parse_mode: "Markdown" });
}

export async function handleInsight(ctx: Context) {
  const user = getTelegramUser(ctx);
  const { walletId } = getOrCreateUserAndWallet(user.id, user.name);

  const rateCheck = checkInsightRateLimit(user.id);
  if (!rateCheck.allowed) {
    await ctx.reply(
      `⏳ *Batas Harian Tercapai*\n\n` +
      `Anda sudah meminta analisa AI hari ini. Untuk menghemat kuota, fitur ini dibatasi 1x sehari (dapat diminta lagi dalam ~${rateCheck.remainingHours} jam).\n\n` +
      `💡 Anda dapat melihat ringkasan keuangan manual kapan saja dengan mengetik \`/rekap\`.`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const yearMonth = `${year}-${String(month).padStart(2, "0")}`;
  const monthName = MONTH_NAMES[month - 1];

  const recap = getMonthlyRecap(walletId, yearMonth);
  const budgets = getBudgetReport(walletId, yearMonth);
  const recapSummary = buildFinancialRecapSummary(recap, budgets, monthName, year);

  try {
    await ctx.replyWithChatAction?.("typing");
  } catch {
    // Abaikan jika chat action tidak didukung
  }

  try {
    const aiInsight = await generateFinancialInsight(recapSummary);
    recordInsightUsage(user.id);

    const sign = recap.netBalance >= 0 ? "+" : "-";
    const netFormatted = `${sign}${formatRupiah(Math.abs(recap.netBalance))}`;

    const replyText =
      `🧠 *Analisa AI untuk Keuanganmu Bulan Ini:*\n\n` +
      `${aiInsight}\n\n` +
      `📊 *Ringkasan ${monthName} ${year}*:\n` +
      `• Pemasukan: ${formatRupiah(recap.totalIncome)}\n` +
      `• Pengeluaran: ${formatRupiah(recap.totalExpense)}\n` +
      `• Selisih (Net): *${netFormatted}*\n\n` +
      `💡 _Gunakan \`/rekap\` untuk melihat rincian grafik per kategori._`;

    try {
      await ctx.reply(replyText, { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(replyText);
    }
  } catch (error: any) {
    logger.warn(`Gagal menghasilkan analisa AI: ${error.message}`);

    const sign = recap.netBalance >= 0 ? "+" : "-";
    const netFormatted = `${sign}${formatRupiah(Math.abs(recap.netBalance))}`;

    let fallbackText =
      `🧠 _Analisa AI sedang tidak tersedia, tapi kamu bisa cek rekap manual di /rekap._\n\n` +
      `📊 *Rekap Keuangan - ${monthName} ${year}*\n\n` +
      `💰 *Total Pemasukan*: ${formatRupiah(recap.totalIncome)}\n` +
      `💸 *Total Pengeluaran*: ${formatRupiah(recap.totalExpense)}\n` +
      `📈 *Selisih (Net)*: *${netFormatted}*\n\n` +
      `📊 *Distribusi Pengeluaran per Kategori*:\n`;

    if (recap.topCategories.length === 0) {
      fallbackText += `_(Belum ada catatan pengeluaran di bulan ini)_\n`;
    } else {
      for (const cat of recap.topCategories) {
        const emoji = getCategoryEmoji(cat.category);
        const bar = generateBarChart(cat.percentage);
        fallbackText += `${emoji} *${cat.category}*  ${bar} ${cat.percentage}% (${formatRupiah(cat.total)})\n`;
      }
    }

    await ctx.reply(fallbackText.trim(), { parse_mode: "Markdown" });
  }
}


export async function handleSaldo(ctx: Context) {
  const user = getTelegramUser(ctx);
  const { walletId } = getOrCreateUserAndWallet(user.id, user.name);
  const { balance, totalIncome, totalExpense } = getWalletBalance(walletId);
  const currentWallet = getWalletById(walletId);

  const text =
    `💰 *Informasi Saldo: ${currentWallet?.name || "Dompet Utama"}*\n\n` +
    `💵 *Sisa Saldo*: *${formatRupiah(balance)}*\n` +
    `🟢 *Total Uang Masuk*: ${formatRupiah(totalIncome)}\n` +
    `🔴 *Total Uang Keluar*: ${formatRupiah(totalExpense)}\n\n` +
    `💡 _Tips_:\n` +
    `• Ketik \`/rekap\` untuk melihat grafik pengeluaran bulan ini.\n` +
    `• Ketik \`/dompet\` untuk melihat daftar seluruh dompet Anda.`;

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
  const dateFormatted = formatDateTimeJakarta(tx.created_at || tx.occurred_at);

  const lines = [
    `${icon} *Transaksi [#${tx.id}] • ${typeLabel}*`,
    `💵 *Nominal*: *${formatRupiah(tx.amount)}*`,
  ];

  if (tx.merchant) lines.push(`🏪 *Toko/Merchant*: ${tx.merchant}`);
  if (tx.category) lines.push(`📂 *Kategori*: ${tx.category}`);
  lines.push(`📅 *Waktu*: ${dateFormatted}`);
  if (tx.note) lines.push(`📝 *Keterangan*: ${tx.note}`);

  return lines.join("\n");
}

export async function handleRiwayat(ctx: Context) {
  const user = getTelegramUser(ctx);
  const { walletId } = getOrCreateUserAndWallet(user.id, user.name);
  const transactions = getRecentTransactions(walletId, 5);

  if (transactions.length === 0) {
    await ctx.reply(
      "📭 *Belum Ada Transaksi*\n\n" +
      "Anda belum memiliki catatan transaksi.\n" +
      "Kirimkan foto nota belanja atau ketik `/expense 25000 makan siang` untuk mulai mencatat!",
      { parse_mode: "Markdown" }
    );
    return;
  }

  await ctx.reply("📜 *5 Transaksi Terakhir Anda:*\n_(Gunakan tombol di bawah transaksi untuk mengedit atau menghapus)_", { parse_mode: "Markdown" });

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
      "💡 *Cara Menghapus Transaksi:*\n\n" +
      "Sertakan nomor ID transaksi yang ingin dihapus.\n\n" +
      "*Format*: `/hapus <nomor_id>`\n" +
      "*Contoh*: `/hapus 12`\n\n" +
      "ℹ️ _Nomor ID dapat dilihat pada daftar_ `/riwayat`",
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
  await ctx.reply(
    `✅ *Transaksi [#${id}] Berhasil Dihapus*\n\n` +
    `Nominal transaksi telah dikembalikan dan saldo dompet sudah disesuaikan.`,
    { parse_mode: "Markdown" }
  );
}

export async function handleEdit(ctx: Context) {
  const match = (ctx.match as string | undefined)?.trim();
  if (!match) {
    await ctx.reply(
      "💡 *Cara Mengedit Transaksi:*\n\n" +
      "Sertakan nomor ID, nominal baru, dan keterangan baru.\n\n" +
      "*Format*: `/edit <id> <nominal_baru> <keterangan_baru>`\n" +
      "*Contoh*: `/edit 12 75000 makan malam di warteg`\n\n" +
      "ℹ️ _Nomor ID dapat dilihat pada daftar_ `/riwayat`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const parts = match.split(/\s+/);
  if (parts.length < 3) {
    await ctx.reply(
      "💡 *Cara Mengedit Transaksi:*\n\n" +
      "Sertakan nomor ID, nominal baru, dan keterangan baru.\n\n" +
      "*Format*: `/edit <id> <nominal_baru> <keterangan_baru>`\n" +
      "*Contoh*: `/edit 12 75000 makan malam di warteg`\n\n" +
      "ℹ️ _Nomor ID dapat dilihat pada daftar_ `/riwayat`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const id = parseInt(parts[0].replace(/^#/, ""), 10);
  const amount = parseRupToInt(parts[1]);
  const note = parts.slice(2).join(" ").trim();

  if (isNaN(id) || !amount || !note) {
    await ctx.reply(
      "💡 *Data edit belum lengkap.*\n\n" +
      "*Format*: `/edit <id> <nominal_baru> <keterangan_baru>`\n" +
      "*Contoh*: `/edit 12 75000 makan malam di warteg`",
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
  await ctx.reply(
    `✅ *Transaksi [#${id}] Berhasil Diperbarui*\n\n` +
    `• Nominal baru: *${formatRupiah(amount)}*\n` +
    `• Keterangan baru: ${note}\n\n` +
    `Saldo dompet telah otomatis disesuaikan.`,
    { parse_mode: "Markdown" }
  );
}

export async function handleTextMessage(ctx: Context) {
  const message = ctx.message;
  const replyTo = message?.reply_to_message;
  if (!message || !replyTo?.text) return;

  // Case 1: Reply to Recurring Bill Reminder with "catat"
  if (replyTo.text.includes("PENGINGAT TAGIHAN")) {
    const rawText = message.text?.trim().toLowerCase() || "";
    if (rawText !== "catat" && rawText !== "/catat") {
      return;
    }

    const user = getTelegramUser(ctx);
    const { userId, walletId } = getOrCreateUserAndWallet(user.id, user.name);
    const userWallets = getUserWallets(userId);
    const userWalletIds = new Set(userWallets.map((w) => w.id));

    // Try finding recurring by ID in [#ID]
    const match = replyTo.text.match(/#(\d+)/);
    let recurring = match ? getRecurringById(parseInt(match[1], 10)) : undefined;

    // Fallback: search by name extracted from the reminder header
    if (!recurring) {
      const nameMatch = replyTo.text.match(/PENGINGAT TAGIHAN:\s*(.+?)(?:\s*\[#\d+\])?\s*sebesar/i);
      if (nameMatch) {
        const candidateName = nameMatch[1].trim();
        for (const wId of userWalletIds) {
          const found = findActiveRecurringByName(wId, candidateName);
          if (found) {
            recurring = found;
            break;
          }
        }
      }
    }

    if (!recurring || !userWalletIds.has(recurring.wallet_id)) {
      await ctx.reply("❌ Data tagihan rutin tidak ditemukan atau bukan milik Anda.");
      return;
    }

    const todayStr = getTodayDateJakarta();
    recordTransactionFromRecurring(recurring, todayStr);
    markRecurringReminded(recurring.id, todayStr);

    const typeIcon = recurring.type === "income" ? "🟢" : "🔴";
    const typeLabel = recurring.type === "income" ? "pemasukan" : "pengeluaran";
    let replyMsg =
      `✅ *Tagihan Berhasil Dicatat!*\n\n` +
      `📌 *Nama*: ${recurring.name}\n` +
      `💰 *Nominal*: ${formatRupiah(recurring.amount)} (${typeIcon} ${typeLabel})\n` +
      `📂 *Kategori*: ${recurring.category || "-"}\n` +
      `📅 *Tanggal*: ${formatDateTimeJakarta(todayStr)}\n\n` +
      `Transaksi telah otomatis dimasukkan ke dalam saldo bulan ini.`;

    if (recurring.type === "expense") {
      const budgetWarning = checkBudgetWarning(
        recurring.wallet_id,
        recurring.category,
        recurring.amount,
        getCurrentYearMonthJakarta()
      );
      if (budgetWarning.isOverbudget && budgetWarning.category) {
        replyMsg += `\n\n⚠️ *PERINGATAN*: Anggaran kategori *${budgetWarning.category}* telah melebihi batas (Overbudget)!`;
      }
    }

    await ctx.reply(replyMsg, { parse_mode: "Markdown" });
    return;
  }

  // Case 2: Reply to Edit Transaction prompt
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
      "💡 *Format balasan belum tepat.*\n\n" +
      "Silakan balas dengan format: `<nominal_baru> <keterangan_baru>`\n" +
      "*Contoh*: `75000 makan malam di warteg`",
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
  await ctx.reply(
    `✅ *Transaksi [#${txId}] Berhasil Diperbarui*\n\n` +
    `• Nominal baru: *${formatRupiah(amount)}*\n` +
    `• Keterangan baru: ${note}\n\n` +
    `Saldo dompet telah otomatis disesuaikan.`,
    { parse_mode: "Markdown" }
  );
}

export async function handleHelp(ctx: Context) {
  const helpText =
    `📖 *Panduan Lengkap Telfin*\n\n` +
    `📸 *1. Catat dari Foto Nota*\n` +
    `• Cukup kirimkan foto struk/nota belanja.\n` +
    `• AI akan mendeteksi nama toko, total belanja, dan kategori.\n` +
    `• Tekan tombol *✅ Konfirmasi* untuk menyimpan ke saldo.\n\n` +
    `✏️ *2. Catat Manual (Ketik Cepat)*\n` +
    `• \`/expense <nominal> <keterangan>\`\n` +
    `  _Contoh_: \`/expense 50000 makan siang\`\n` +
    `• \`/income <nominal> <keterangan>\`\n` +
    `  _Contoh_: \`/income 1500000 gaji bulanan\`\n\n` +
    `📊 *3. Cek Saldo & Riwayat*\n` +
    `• \`/saldo\` — Cek sisa saldo & ringkasan uang masuk/keluar\n` +
    `• \`/riwayat\` — Lihat 5 transaksi terakhir (bisa edit/hapus)\n` +
    `• \`/rekap\` — Laporan & grafik pengeluaran per kategori\n` +
    `• \`/insight\` — Analisa & saran keuangan bulanan dari AI\n` +
    `• \`/cari <kata>\` — Cari transaksi (contoh: \`/cari bensin\`)\n` +
    `• \`/export\` — Ekspor seluruh transaksi ke file Excel/CSV\n` +
    `• \`/import\` — Impor data transaksi dari file CSV\n\n` +
    `🎯 *4. Batas Anggaran Bulanan*\n` +
    `• \`/anggaran <kategori> <nominal>\`\n` +
    `  _Contoh_: \`/anggaran makan 1500000\`\n` +
    `• \`/cekanggaran\` — Cek sisa kuota belanja bulan ini\n\n` +
    `🔔 *5. Tagihan Rutin & Pengingat*\n` +
    `• \`/langganan\` — Lihat daftar tagihan rutin aktif\n` +
    `• \`/tambahlangganan <nama> <nominal> <tipe> <kategori> <tgl>\`\n` +
    `  _Contoh_: \`/tambahlangganan Netflix 54000 expense hiburan 25\`\n` +
    `• \`/hapuslangganan <id>\` — Hapus pengingat tagihan\n\n` +
    `💳 *6. Dompet & Backup*\n` +
    `• \`/dompet\` — Daftar semua dompet & saldo\n` +
    `• \`/setdefault <nama>\` — Ganti dompet utama\n` +
    `• \`/tambahdompet <nama>\` — Buat dompet baru (misal: Bank BCA)\n` +
    `• \`/backup\` — Unduh file cadangan database .db\n` +
    `• \`/restore\` — Pulihkan database dari file .db`;

  await ctx.reply(helpText, { parse_mode: "Markdown" });
}

export async function handleDompet(ctx: Context) {
  const user = getTelegramUser(ctx);
  const { userId } = getOrCreateUserAndWallet(user.id, user.name);
  const wallets = getUserWallets(userId);

  let text = `💳 *Daftar Dompet Anda*:\n\n`;
  for (const w of wallets) {
    const { balance } = getWalletBalance(w.id);
    const defaultBadge = w.is_default ? " ⭐ *(Dompet Utama)*" : "";
    text += `• *${w.name}*${defaultBadge}\n  Saldo: *${formatRupiah(balance)}*\n`;
  }
  text += `\n───────────────────\n`;
  text += `💡 *Perintah Dompet*:\n`;
  text += `• \`/setdefault <nama_dompet>\` — Ganti dompet utama\n`;
  text += `• \`/tambahdompet <nama_dompet>\` — Tambah dompet baru\n`;
  text += `\n*Contoh*: \`/tambahdompet Bank BCA\` atau \`/setdefault Bank BCA\``;

  await ctx.reply(text, { parse_mode: "Markdown" });
}

export async function handleSetDefault(ctx: Context) {
  const match = ctx.match as string | undefined;
  if (!match || !match.trim()) {
    await ctx.reply(
      "💡 *Cara Mengubah Dompet Utama:*\n\n" +
      "Ketik nama dompet yang ingin dijadikan sebagai dompet utama.\n\n" +
      "*Format*: `/setdefault <nama_dompet>`\n" +
      "*Contoh*:\n" +
      "• `/setdefault Dompet Utama`\n" +
      "• `/setdefault Bank BCA`\n\n" +
      "ℹ️ _Ketik_ `/dompet` _untuk melihat daftar nama dompet Anda._",
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
      `❌ Dompet "*${walletName}*" tidak ditemukan.\nKetik \`/dompet\` untuk melihat daftar dompet Anda.`,
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
      "💡 *Cara Menambahkan Dompet Baru:*\n\n" +
      "Ketik nama dompet yang ingin dibuat.\n\n" +
      "*Format*: `/tambahdompet <nama_dompet>`\n" +
      "*Contoh*:\n" +
      "• `/tambahdompet Bank BCA`\n" +
      "• `/tambahdompet Gopay`\n" +
      "• `/tambahdompet Tabungan`",
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
      "💡 *Cara Mencari Riwayat Transaksi:*\n\n" +
      "Ketik kata kunci nama toko, barang, atau keterangan transaksi.\n\n" +
      "*Format*: `/cari <kata_kunci>`\n" +
      "*Contoh*:\n" +
      "• `/cari indomaret`\n" +
      "• `/cari bensin`\n" +
      "• `/cari kopi`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const user = getTelegramUser(ctx);
  const { userId } = getOrCreateUserAndWallet(user.id, user.name);

  const results = searchTransactions(userId, match, 10);
  if (results.length === 0) {
    await ctx.reply(
      `🔍 Tidak ditemukan transaksi dengan kata kunci "*${match}*".\n` +
      `Coba gunakan kata kunci yang lebih singkat atau umum.`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  let text = `🔍 *Hasil Pencarian: "${match}"*\n\n`;
  for (const tx of results) {
    const timeStr = formatDateTimeJakarta(tx.created_at || tx.occurred_at);
    const merchant = tx.merchant || tx.note || "-";
    text += `[#${tx.id}] ${timeStr} | ${merchant} | ${formatRupiah(tx.amount)}\n`;
  }

  await ctx.reply(text.trim(), { parse_mode: "Markdown" });
}

export async function handleExport(ctx: Context) {
  try {
    const user = getTelegramUser(ctx);
    const { userId } = getOrCreateUserAndWallet(user.id, user.name);

    const transactions = getAllConfirmedTransactions(userId);
    if (transactions.length === 0) {
      await ctx.reply(
        "📭 *Belum Ada Data Transaksi*\n\n" +
        "Belum ada catatan transaksi yang bisa diekspor.",
        { parse_mode: "Markdown" }
      );
      return;
    }

    const csvString = formatTransactionsCsv(transactions);
    const buffer = Buffer.from(csvString, "utf-8");
    const dateStr = new Date().toISOString().slice(0, 10);
    const fileName = `export_telfin_${dateStr}.csv`;

    await ctx.replyWithDocument(new InputFile(buffer, fileName), {
      caption:
        `📊 *Ekspor Data Berhasil!*\n\n` +
        `Total *${transactions.length}* transaksi berhasil diekspor ke file CSV.\n` +
        `File ini dapat dibuka langsung di Excel, Google Sheets, atau aplikasi spreadsheet lainnya.`,
      parse_mode: "Markdown",
    });
  } catch (err: any) {
    logger.error("Gagal melakukan export transaksi:", err);
    await ctx.reply("❌ Gagal mengekspor data transaksi. Silakan coba lagi.");
  }
}

export async function handleAnggaran(ctx: Context) {
  const match = (ctx.match as string | undefined)?.trim();
  if (!match) {
    await ctx.reply(
      "💡 *Cara Mengatur Batas Anggaran Bulanan:*\n\n" +
      "Tentukan kategori dan nominal maksimal belanja untuk bulan ini.\n\n" +
      "*Format*: `/anggaran <kategori> <nominal>`\n" +
      "*Contoh*:\n" +
      "• `/anggaran makan 1500000`\n" +
      "• `/anggaran nongkrong 500000`\n" +
      "• `/anggaran bensin 300000`\n\n" +
      "ℹ️ _Ketik_ `/cekanggaran` _untuk melihat status pemakaian._",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const parts = match.split(/\s+/);
  if (parts.length < 2) {
    await ctx.reply(
      "💡 *Cara Mengatur Batas Anggaran Bulanan:*\n\n" +
      "Tentukan kategori dan nominal maksimal belanja untuk bulan ini.\n\n" +
      "*Format*: `/anggaran <kategori> <nominal>`\n" +
      "*Contoh*:\n" +
      "• `/anggaran makan 1500000`\n" +
      "• `/anggaran nongkrong 500000`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const amountStr = parts[parts.length - 1];
  const amount = parseRupToInt(amountStr);
  const category = parts.slice(0, -1).join(" ").trim();

  if (!amount || !category) {
    await ctx.reply(
      "💡 *Nominal atau kategori belum sesuai.*\n\n" +
      "*Contoh*: `/anggaran makan 1500000`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const user = getTelegramUser(ctx);
  const { walletId } = getOrCreateUserAndWallet(user.id, user.name);
  const monthYear = getCurrentYearMonthJakarta();

  setBudget(walletId, category, amount, monthYear);

  await ctx.reply(
    `✅ *Batas Anggaran Berhasil Disetel!*\n\n` +
    `📂 *Kategori*: ${category}\n` +
    `🎯 *Batas Maksimal*: *${formatRupiah(amount)}* / bulan\n\n` +
    `Bot akan memberi peringatan jika belanja Anda di kategori ini sudah melebihi batas.`,
    { parse_mode: "Markdown" }
  );
}

export async function handleCekAnggaran(ctx: Context) {
  const user = getTelegramUser(ctx);
  const { walletId } = getOrCreateUserAndWallet(user.id, user.name);
  const monthYear = getCurrentYearMonthJakarta();

  const budgets = getBudgetReport(walletId, monthYear);
  if (budgets.length === 0) {
    await ctx.reply(
      `📊 *Status Anggaran Bulan Ini (${monthYear})*\n\n` +
      `Belum ada batas anggaran yang disetel untuk bulan ini.\n\n` +
      `💡 *Cara membuat batas anggaran*:\n` +
      `Ketik \`/anggaran <kategori> <nominal>\`\n` +
      `*Contoh*: \`/anggaran makan 1500000\``,
      { parse_mode: "Markdown" }
    );
    return;
  }

  let text = `📊 *Status Anggaran Bulan Ini (${monthYear})*\n\n`;
  for (const b of budgets) {
    const remaining = b.amount_limit - b.total_spent;
    const percentage = b.amount_limit > 0 ? Math.round((b.total_spent / b.amount_limit) * 100) : 0;
    const statusIcon = percentage > 100 ? "🔴" : percentage >= 80 ? "🟡" : "🟢";
    const statusText = percentage > 100 ? " *(Overbudget / Boros!)*" : "";

    text += `${statusIcon} *${b.category}*${statusText}\n`;
    text += `  • Terpakai: ${formatRupiah(b.total_spent)} / ${formatRupiah(b.amount_limit)} (${percentage}%)\n`;
    if (remaining >= 0) {
      text += `  • Sisa Kuota: ${formatRupiah(remaining)}\n\n`;
    } else {
      text += `  • Melebihi Batas: ${formatRupiah(Math.abs(remaining))}\n\n`;
    }
  }

  await ctx.reply(text.trim(), { parse_mode: "Markdown" });
}

export async function handleBackup(ctx: Context) {
  try {
    // Checkpoint SQLite WAL so bot.db has all latest transactions
    db.pragma("wal_checkpoint(TRUNCATE)");

    const buffer = await fs.promises.readFile(dbPath);
    const dateStr = new Date().toISOString().slice(0, 10);
    const fileName = `telfin_backup_${dateStr}.db`;

    await ctx.replyWithDocument(new InputFile(buffer, fileName), {
      caption:
        "✅ *Cadangan Database Berhasil Diunduh!*\n\n" +
        "Simpan file `.db` ini di tempat aman. File ini berisi seluruh riwayat transaksi, dompet, anggaran, dan langganan Anda.",
      parse_mode: "Markdown",
    });
  } catch (err: any) {
    logger.error("Gagal melakukan backup database:", err);
    await ctx.reply("❌ Gagal membuat cadangan database.");
  }
}

export async function handleRestore(ctx: Context) {
  const replyTo = ctx.message?.reply_to_message;
  const doc = replyTo?.document;

  if (doc) {
    return processRestoreDocument(ctx, doc);
  }

  await ctx.reply(
    "📥 *Cara Memulihkan Database (Restore):*\n\n" +
    "1. Siapkan file backup berformat `.db`.\n" +
    "2. *Balas (reply)* pesan ini dengan melampirkan/mengirim file `.db` tersebut sebagai Document.\n\n" +
    "⚠️ *Peringatan*: Seluruh data saat ini akan digantikan dengan data dari file cadangan yang diunggah.",
    {
      reply_markup: { force_reply: true },
      parse_mode: "Markdown",
    }
  );
}

export async function handleImport(ctx: Context) {
  const promptText =
    "📥 *Impor Data Transaksi (CSV)*\n\n" +
    "1. Siapkan file data transaksi berformat `.csv`.\n" +
    "2. *Balas (reply)* pesan ini dengan melampirkan file `.csv` tersebut sebagai Document, atau kirim file dokumen dengan caption `/import`.\n\n" +
    "📋 *Format kolom standar*:\n" +
    "`ID,Tanggal,Tipe,Kategori,Merchant,Nominal,Keterangan`\n\n" +
    "💡 _Tips: Anda dapat langsung mengimpor file hasil dari perintah_ `/export`_._";

  await ctx.reply(promptText, {
    reply_markup: { force_reply: true },
    parse_mode: "Markdown",
  });
}

export async function handleDocument(ctx: Context) {
  const message = ctx.message;
  const doc = message?.document;
  if (!doc) return;

  const replyTo = message.reply_to_message;
  const isReplyToRestorePrompt =
    replyTo?.text?.includes("Silakan balas pesan ini dengan mengunggah file backup .db Anda") ||
    replyTo?.text?.includes("Memulihkan Database (Restore)");
  const hasRestoreCaption = message.caption?.trim() === "/restore";

  if (isReplyToRestorePrompt || hasRestoreCaption) {
    return processRestoreDocument(ctx, doc);
  }

  const isReplyToImportPrompt =
    replyTo?.text?.includes("Impor Data Transaksi (CSV)") ||
    replyTo?.text?.includes("file .csv") ||
    replyTo?.text?.includes("file `.csv`");
  const hasImportCaption = message.caption?.trim() === "/import";
  const isCsvDoc = (doc.file_name || "").toLowerCase().endsWith(".csv") || (doc.mime_type || "").includes("csv");

  if (isReplyToImportPrompt || hasImportCaption || (isCsvDoc && replyTo)) {
    return processImportDocument(ctx, doc);
  }
}

async function processImportDocument(ctx: Context, doc: any) {
  const fileName = (doc.file_name || "").toLowerCase();
  const mimeType = (doc.mime_type || "").toLowerCase();
  const isCsv = fileName.endsWith(".csv") || mimeType.includes("csv") || mimeType.includes("text/plain");

  if (!isCsv) {
    await ctx.reply("❌ File tidak valid. Harap unggah file dengan format `.csv`.", {
      parse_mode: "Markdown",
    });
    return;
  }

  const statusMsg = await ctx.reply("⏳ _Membaca dan memverifikasi file CSV..._", {
    parse_mode: "Markdown",
  });

  const uploadsDir = path.join(process.cwd(), "uploads");
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

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
    const csvContent = buffer.toString("utf-8");

    const parsed = parseCsvTransactions(csvContent);
    if (parsed.totalRows === 0) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        "❌ File CSV kosong atau tidak memiliki data transaksi."
      );
      return;
    }

    if (parsed.valid.length === 0) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        `❌ Tidak ada data yang valid untuk diimpor dari ${parsed.totalRows} baris. Pastikan format kolom sesuai.`
      );
      return;
    }

    // Save CSV to temporary file in uploads/
    const importId = crypto.randomBytes(6).toString("hex");
    const tempPath = path.join(uploadsDir, `import_${importId}.csv`);
    await fs.promises.writeFile(tempPath, buffer);

    const user = getTelegramUser(ctx);
    const { walletId } = getOrCreateUserAndWallet(user.id, user.name);
    const defaultWallet = getWalletById(walletId);
    const walletName = defaultWallet ? defaultWallet.name : "Dompet Default";

    let previewText =
      `📂 Ditemukan *${parsed.totalRows}* baris data di file CSV.\n\n` +
      `Apakah Anda ingin mengimpor semuanya ke *${walletName}*?`;

    if (parsed.skipped > 0) {
      previewText += `\n\n⚠️ _Catatan: ${parsed.skipped} baris formatnya tidak sesuai dan akan dilewati otomatis._`;
    }

    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, previewText, {
      parse_mode: "Markdown",
      reply_markup: createImportConfirmationKeyboard(importId),
    });
  } catch (err: any) {
    logger.error("Gagal memproses file CSV import:", err);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      statusMsg.message_id,
      "❌ Terjadi kesalahan saat membaca file CSV. Pastikan file tidak rusak dan coba lagi."
    );
  }
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
  const timeStr = formatDateTimeJakarta(tx.occurred_at || new Date());
  return (
    `🧾 *Hasil Pembacaan Struk / Nota*\n\n` +
    `🏷️ *Tipe*: ${typeLabel}\n` +
    `💵 *Nominal*: *${formatRupiah(tx.amount)}*\n` +
    `🏪 *Toko / Merchant*: ${tx.merchant || "-"}\n` +
    `📂 *Kategori*: ${tx.category || "-"}\n` +
    `📅 *Waktu*: ${timeStr}\n` +
    (tx.note ? `📝 *Catatan*: _${tx.note}_\n` : "") +
    `Akan dicatat ke: 💳 *${walletName}*\n\n` +
    `⚠️ *Status: Menunggu Konfirmasi Anda*\n` +
    `Silakan periksa data di atas, lalu tekan tombol konfirmasi di bawah:`
  );
}

export async function handlePhoto(ctx: Context) {
  const user = getTelegramUser(ctx);
  const { walletId } = getOrCreateUserAndWallet(user.id, user.name);

  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0) {
    await ctx.reply("Foto tidak terdeteksi. Silakan kirimkan foto nota yang jelas.");
    return;
  }

  const statusMsg = await ctx.reply("⏳ _Sedang membaca struk/nota belanja Anda dengan AI... Mohon tunggu sebentar._", {
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
        "⚠️ *Foto Nota Pernah Dicatat*\n\nNota ini sudah ada di catatan keuangan Anda sebelumnya. Untuk mencegah pencatatan ganda, transaksi ini tidak diproses ulang.",
        { parse_mode: "Markdown" }
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

  // 3b. Flow Konfirmasi Import CSV: confirm_import:<importId>
  if (data.startsWith("confirm_import:")) {
    const importId = data.slice("confirm_import:".length);
    const uploadsDir = path.join(process.cwd(), "uploads");
    const tempPath = path.join(uploadsDir, `import_${importId}.csv`);

    if (!fs.existsSync(tempPath)) {
      await ctx.answerCallbackQuery({ text: "Sesi impor telah kedaluwarsa atau file sudah diproses." });
      return;
    }

    try {
      const content = await fs.promises.readFile(tempPath, "utf-8");
      const parsed = parseCsvTransactions(content);

      const defaultWallet = userWallets.find((w) => w.is_default) || userWallets[0];
      const targetWalletId = defaultWallet ? defaultWallet.id : userWallets[0]?.id;

      if (!targetWalletId) {
        await ctx.answerCallbackQuery({ text: "Dompet tidak ditemukan." });
        return;
      }

      const importedCount = importTransactionsBulk(targetWalletId, parsed.valid);

      // Clean up temp file
      try {
        await fs.promises.unlink(tempPath);
      } catch (_) {}

      const walletName = defaultWallet ? defaultWallet.name : "Dompet Default";
      let summaryMsg = `✅ Berhasil mengimpor *${importedCount}* transaksi. Saldo telah diperbarui.`;
      if (parsed.skipped > 0) {
        summaryMsg =
          `✅ Berhasil mengimpor *${importedCount}* transaksi.\n` +
          `⚠️ *${parsed.skipped}* baris dilewati karena format tidak sesuai.\n\n` +
          `Saldo dompet *${walletName}* telah diperbarui.`;
      }

      await ctx.editMessageText(summaryMsg, { parse_mode: "Markdown" });
      await ctx.answerCallbackQuery({ text: `Berhasil mengimpor ${importedCount} transaksi!` });
    } catch (err: any) {
      logger.error("Error saat bulk insert transaksi import:", err);
      await ctx.editMessageText("❌ Terjadi kesalahan saat mengimpor data ke database. Silakan coba lagi.");
      await ctx.answerCallbackQuery({ text: "Gagal mengimpor data." });
    }
    return;
  }

  // 3c. Flow Batal Import CSV: cancel_import:<importId>
  if (data.startsWith("cancel_import:")) {
    const importId = data.slice("cancel_import:".length);
    const uploadsDir = path.join(process.cwd(), "uploads");
    const tempPath = path.join(uploadsDir, `import_${importId}.csv`);
    if (fs.existsSync(tempPath)) {
      try {
        await fs.promises.unlink(tempPath);
      } catch (_) {}
    }

    await ctx.editMessageText("❌ *Impor Dibatalkan*\nData dari file CSV tidak dimasukkan ke dalam dompet.", {
      parse_mode: "Markdown",
    });
    await ctx.answerCallbackQuery({ text: "Impor dibatalkan." });
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
    // Check budget warning for expense transaction before confirming
    const monthYear = getCurrentYearMonthJakarta();
    const budgetWarning = tx.type === "expense"
      ? checkBudgetWarning(tx.wallet_id, tx.category, tx.amount, monthYear)
      : { isOverbudget: false };

    confirmTransaction(transactionId, tx.wallet_id);
    const { balance } = getWalletBalance(tx.wallet_id);
    const targetWallet = getWalletById(tx.wallet_id);

    const typeIcon = tx.type === "income" ? "🟢" : "🔴";
    const timeStr = formatDateTimeJakarta(tx.created_at || tx.occurred_at || new Date());
    let resultText =
      `✅ *Transaksi Berhasil Disimpan!*\n\n` +
      `${typeIcon} *Nominal*: ${formatRupiah(tx.amount)}\n` +
      `🏪 *Merchant*: ${tx.merchant || "-"}\n` +
      `📂 *Kategori*: ${tx.category || "-"}\n` +
      `📅 *Waktu*: ${timeStr}\n` +
      `💳 *Dompet*: ${targetWallet?.name || "Dompet Utama"}\n\n` +
      `💰 *Saldo Dompet Saat Ini*: *${formatRupiah(balance)}*`;

    if (budgetWarning.isOverbudget && budgetWarning.category) {
      resultText += `\n\n⚠️ *PERINGATAN*: Anggaran kategori *${budgetWarning.category}* bulan ini telah melebihi batas (Overbudget)!`;
    }

    await ctx.editMessageText(resultText, { parse_mode: "Markdown" });
    await ctx.answerCallbackQuery({
      text: budgetWarning.isOverbudget
        ? `⚠️ Peringatan: Anggaran ${budgetWarning.category} melebihi batas!`
        : "Transaksi berhasil dikonfirmasi!",
    });
  } else if (action === "cancel") {
    cancelTransaction(transactionId, tx.wallet_id);

    const resultText =
      `❌ *Transaksi Dibatalkan*\n\n` +
      `Nominal *${formatRupiah(tx.amount)}* tidak dimasukkan ke dalam saldo.`;

    await ctx.editMessageText(resultText, { parse_mode: "Markdown" });
    await ctx.answerCallbackQuery({ text: "Transaksi dibatalkan." });
  }
}

export async function handleLangganan(ctx: Context) {
  const user = getTelegramUser(ctx);
  const { walletId } = getOrCreateUserAndWallet(user.id, user.name);
  const wallet = getWalletById(walletId);
  const recurrings = getUserRecurrings(walletId);

  if (recurrings.length === 0) {
    const emptyText =
      `📋 *Daftar Tagihan Rutin*\n\n` +
      `Belum ada tagihan rutin yang aktif di dompet *${wallet?.name || "Dompet Utama"}*.\n\n` +
      `➕ *Cara Menambahkan*:\n` +
      `\`/tambahlangganan <nama> <nominal> <tipe> <kategori> <tanggal(1-31)>\`\n\n` +
      `*Contoh*:\n` +
      `• \`/tambahlangganan Netflix 50000 expense hiburan 25\`\n` +
      `• \`/tambahlangganan Kos Bulanan 1500000 expense kos 1\`\n` +
      `• \`/tambahlangganan Gaji Kantor 8000000 income gaji 25\``;
    await ctx.reply(emptyText, { parse_mode: "Markdown" });
    return;
  }

  let totalExpense = 0;
  let totalIncome = 0;

  const itemsText = recurrings
    .map((item) => {
      const isExpense = item.type === "expense";
      if (isExpense) totalExpense += item.amount;
      else totalIncome += item.amount;
      const typeIcon = isExpense ? "🔴" : "🟢";
      return (
        `[#${item.id}] ${typeIcon} *${item.name}*\n` +
        `• Nominal: *${formatRupiah(item.amount)}*\n` +
        `• Kategori: ${item.category || "-"}\n` +
        `• Jatuh Tempo: Tanggal ${item.due_day} setiap bulan`
      );
    })
    .join("\n\n");

  let summaryText = `\n\n───────────────────\n`;
  if (totalExpense > 0) {
    summaryText += `🔴 *Total Tagihan/Bln*: ${formatRupiah(totalExpense)}\n`;
  }
  if (totalIncome > 0) {
    summaryText += `🟢 *Total Pendapatan Rutin/Bln*: ${formatRupiah(totalIncome)}\n`;
  }

  const messageText =
    `📋 *Daftar Tagihan Rutin*\n` +
    `💳 *Dompet*: ${wallet?.name || "Dompet Utama"}\n\n` +
    itemsText +
    summaryText +
    `\n💡 *Perintah*:\n` +
    `• Hapus: \`/hapuslangganan <id>\`\n` +
    `• Tambah: \`/tambahlangganan <nama> <nominal> <tipe> <kategori> <tanggal>\``;

  await ctx.reply(messageText, { parse_mode: "Markdown" });
}

export async function handleTambahLangganan(ctx: Context) {
  const match = ctx.match as string | undefined;
  if (!match || !match.trim()) {
    await ctx.reply(
      "❌ Format salah.\n\n" +
      "Gunakan format: `/tambahlangganan <nama> <nominal> <tipe> <kategori> <tanggal(1-31)>`\n" +
      "Contoh: `/tambahlangganan Netflix 50000 expense hiburan 25`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const parts = match.trim().split(/\s+/);
  if (parts.length < 5) {
    await ctx.reply(
      "💡 *Cara Menambahkan Tagihan Rutin:*\n\n" +
      "Daftarkan pengeluaran/pemasukan rutin agar bot otomatis mengingatkan setiap tanggal jatuh tempo.\n\n" +
      "*Format*: `/tambahlangganan <nama> <nominal> <tipe> <kategori> <tanggal>`\n\n" +
      "*Contoh Pengeluaran:*\n" +
      "• `/tambahlangganan Netflix 54000 expense hiburan 25`\n" +
      "• `/tambahlangganan Kos Bulanan 1500000 expense kos 1`\n\n" +
      "*Contoh Pemasukan:*\n" +
      "• `/tambahlangganan Gaji Kantor 8000000 income gaji 25`\n\n" +
      "ℹ️ _Tipe berupa `expense` (pengeluaran) atau `income` (pemasukan), dan tanggal antara 1 sampai 31._",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const dueDayRaw = parts[parts.length - 1];
  const category = parts[parts.length - 2];
  const typeRaw = parts[parts.length - 3].toLowerCase();
  const amountRaw = parts[parts.length - 4];
  const name = parts.slice(0, parts.length - 4).join(" ").trim();

  if (!name) {
    await ctx.reply("❌ Nama tagihan tidak boleh kosong.", { parse_mode: "Markdown" });
    return;
  }

  const amount = parseRupToInt(amountRaw);
  if (!amount || amount <= 0) {
    await ctx.reply("❌ Nominal harus berupa angka lebih dari 0. Contoh: `50000`", { parse_mode: "Markdown" });
    return;
  }

  let type: "income" | "expense";
  if (["expense", "pengeluaran", "keluar"].includes(typeRaw)) {
    type = "expense";
  } else if (["income", "pemasukan", "masuk", "gaji"].includes(typeRaw)) {
    type = "income";
  } else {
    await ctx.reply(
      "❌ Tipe tidak valid. Gunakan `expense` atau `income`.\nContoh: `/tambahlangganan Netflix 50000 expense hiburan 25`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const dueDay = parseInt(dueDayRaw, 10);
  if (isNaN(dueDay) || dueDay < 1 || dueDay > 31) {
    await ctx.reply("❌ Tanggal jatuh tempo harus berupa angka antara 1 sampai 31.", { parse_mode: "Markdown" });
    return;
  }

  const user = getTelegramUser(ctx);
  const { walletId } = getOrCreateUserAndWallet(user.id, user.name);
  const wallet = getWalletById(walletId);

  const rec = createRecurring(walletId, name, amount, type, category, dueDay);

  const typeIcon = rec.type === "expense" ? "🔴 Pengeluaran" : "🟢 Pemasukan";
  const replyText =
    `✅ *Tagihan Rutin Berhasil Ditambahkan!*\n\n` +
    `📌 *Nama*: ${rec.name}\n` +
    `💰 *Nominal*: ${formatRupiah(rec.amount)} (${typeIcon})\n` +
    `📂 *Kategori*: ${rec.category || "-"}\n` +
    `📅 *Jatuh Tempo*: Setiap tanggal ${rec.due_day}\n` +
    `💳 *Dompet*: ${wallet?.name || "Dompet Utama"}\n\n` +
    `🔔 Bot akan otomatis mengirimkan pengingat setiap tanggal ${rec.due_day}.`;

  await ctx.reply(replyText, { parse_mode: "Markdown" });
}

export async function handleHapusLangganan(ctx: Context) {
  const match = ctx.match as string | undefined;
  if (!match || !match.trim()) {
    await ctx.reply(
      "💡 *Cara Menonaktifkan Tagihan Rutin:*\n\n" +
      "Sertakan nomor ID tagihan yang ingin dinonaktifkan.\n\n" +
      "*Format*: `/hapuslangganan <nomor_id>`\n" +
      "*Contoh*: `/hapuslangganan 1`\n\n" +
      "ℹ️ _Ketik_ `/langganan` _untuk melihat daftar nomor ID tagihan Anda._",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const id = parseInt(match.trim(), 10);
  if (isNaN(id) || id <= 0) {
    await ctx.reply("❌ ID tagihan harus berupa angka positif. Contoh: `/hapuslangganan 1`", { parse_mode: "Markdown" });
    return;
  }

  const user = getTelegramUser(ctx);
  const { userId } = getOrCreateUserAndWallet(user.id, user.name);
  const userWallets = getUserWallets(userId);
  const userWalletIds = new Set(userWallets.map((w) => w.id));

  const rec = getRecurringById(id);
  if (!rec || !userWalletIds.has(rec.wallet_id)) {
    await ctx.reply("❌ Tagihan rutin tidak ditemukan atau bukan milik Anda.");
    return;
  }

  if (rec.is_active === 0) {
    await ctx.reply(`ℹ️ Tagihan rutin *${rec.name}* (ID: #${rec.id}) sudah tidak aktif.`, { parse_mode: "Markdown" });
    return;
  }

  deactivateRecurring(id, rec.wallet_id);
  await ctx.reply(`✅ Tagihan rutin *${rec.name}* (ID: #${rec.id}) berhasil dinonaktifkan.`, { parse_mode: "Markdown" });
}

