import type { Context } from "grammy";
import path from "node:path";
import { formatRupiah } from "../utils/money.js";
import { logger } from "../utils/logger.js";
import {
  getOrCreateUserAndWallet,
  createPendingTransaction,
  confirmTransaction,
  cancelTransaction,
  getTransactionById,
  getWalletBalance,
  getRecentTransactions,
} from "../services/transaction.service.js";
import { saveUploadedBuffer, processReceiptFile } from "../services/receipt.service.js";
import { createTransactionConfirmationKeyboard } from "./keyboards.js";

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
    `• /saldo - Cek saldo dompet & ringkasan\n` +
    `• /riwayat - Lihat 5 transaksi terakhir\n` +
    `• /help - Panduan lengkap`;

  await ctx.reply(welcomeText, { parse_mode: "Markdown" });
}

export async function handleSaldo(ctx: Context) {
  const user = getTelegramUser(ctx);
  const { walletId } = getOrCreateUserAndWallet(user.id, user.name);
  const { balance, totalIncome, totalExpense } = getWalletBalance(walletId);

  const text =
    `📊 *Ringkasan Dompet Utama*\n\n` +
    `💰 *Saldo*: ${formatRupiah(balance)}\n` +
    `📈 *Total Pemasukan*: ${formatRupiah(totalIncome)}\n` +
    `📉 *Total Pengeluaran*: ${formatRupiah(totalExpense)}`;

  await ctx.reply(text, { parse_mode: "Markdown" });
}

export async function handleRiwayat(ctx: Context) {
  const user = getTelegramUser(ctx);
  const { walletId } = getOrCreateUserAndWallet(user.id, user.name);
  const transactions = getRecentTransactions(walletId, 5);

  if (transactions.length === 0) {
    await ctx.reply("Belum ada transaksi yang tersimpan. Kirim foto nota Anda untuk memulai!");
    return;
  }

  let text = `📜 *5 Transaksi Terakhir:*\n\n`;
  for (const tx of transactions) {
    const icon = tx.type === "income" ? "🟢" : "🔴";
    const sign = tx.type === "income" ? "+" : "-";
    const merchant = tx.merchant ? ` (${tx.merchant})` : "";
    const category = tx.category ? ` [${tx.category}]` : "";
    const date = tx.occurred_at || tx.created_at.slice(0, 10);

    text += `${icon} *${sign}${formatRupiah(tx.amount)}*${merchant}${category}\n`;
    text += `   📅 ${date}${tx.note ? ` • _${tx.note}_` : ""}\n\n`;
  }

  await ctx.reply(text.trim(), { parse_mode: "Markdown" });
}

export async function handleHelp(ctx: Context) {
  const helpText =
    `📖 *Panduan Penggunaan Bot*\n\n` +
    `1. *Kirim Foto Nota*: Foto nota Anda, kirim ke chat ini. AI akan mengekstrak nominal secara otomatis.\n` +
    `2. *Konfirmasi Transaksi*: Transaksi awalnya berstatus *pending*. Anda harus klik '✅ Konfirmasi' agar masuk ke saldo.\n` +
    `3. *Batalkan*: Klik '❌ Batalkan' jika data salah atau nota tidak ingin dicatat.\n\n` +
    `*Daftar Perintah*:\n` +
    `• /start - Memulai bot & cek status dompet\n` +
    `• /saldo - Menampilkan sisa saldo dan total pengeluaran/pemasukan\n` +
    `• /riwayat - Melihat daftar riwayat transaksi terkonfirmasi\n` +
    `• /help - Menampilkan pesan bantuan ini`;

  await ctx.reply(helpText, { parse_mode: "Markdown" });
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
    const ext = path.extname(file.file_path) || ".jpg";
    const localPath = saveUploadedBuffer(buffer, ext);

    const extraction = await processReceiptFile(localPath);

    // Save as pending transaction
    const txId = createPendingTransaction(walletId, extraction, localPath);

    const typeLabel = extraction.type === "income" ? "🟢 Pemasukan" : "🔴 Pengeluaran";
    const previewText =
      `🧾 *Preview Transaksi Nota*\n\n` +
      `🏷️ *Tipe*: ${typeLabel}\n` +
      `💵 *Nominal*: *${formatRupiah(extraction.amount)}*\n` +
      `🏪 *Merchant*: ${extraction.merchant || "-"}\n` +
      `📂 *Kategori*: ${extraction.category}\n` +
      `📅 *Tanggal*: ${extraction.occurred_at || "-"}\n` +
      (extraction.note ? `📝 *Catatan*: _${extraction.note}_\n\n` : "\n") +
      `⚠️ *Status: Menunggu Konfirmasi*\n` +
      `Klik tombol di bawah untuk menyimpan transaksi ke saldo Anda.`;

    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, previewText, {
      parse_mode: "Markdown",
      reply_markup: createTransactionConfirmationKeyboard(txId),
    });
  } catch (error: any) {
    logger.error("Error processing receipt photo:", error);
    const errorMsg =
      `❌ *Gagal membaca nota*\n\n` +
      `Penyebab: ${error.message || "Foto kurang jelas atau terjadi kesalahan AI."}\n` +
      `Silakan coba foto ulang dengan pencahayaan yang cukup.`;

    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, errorMsg, {
      parse_mode: "Markdown",
    });
  }
}

export async function handleCallbackQuery(ctx: Context) {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const [action, idStr] = data.split(":");
  const transactionId = parseInt(idStr, 10);

  if (isNaN(transactionId)) {
    await ctx.answerCallbackQuery({ text: "ID Transaksi tidak valid." });
    return;
  }

  const user = getTelegramUser(ctx);
  const { walletId } = getOrCreateUserAndWallet(user.id, user.name);
  const tx = getTransactionById(transactionId);

  if (!tx || tx.wallet_id !== walletId) {
    await ctx.answerCallbackQuery({ text: "Transaksi tidak ditemukan atau bukan milik Anda." });
    return;
  }

  if (tx.status !== "pending") {
    await ctx.answerCallbackQuery({ text: `Transaksi ini sudah ${tx.status}.` });
    return;
  }

  if (action === "confirm") {
    confirmTransaction(transactionId, walletId);
    const { balance } = getWalletBalance(walletId);

    const typeIcon = tx.type === "income" ? "🟢" : "🔴";
    const resultText =
      `✅ *Transaksi Berhasil Disimpan!*\n\n` +
      `${typeIcon} *Nominal*: ${formatRupiah(tx.amount)}\n` +
      `🏪 *Merchant*: ${tx.merchant || "-"}\n` +
      `📂 *Kategori*: ${tx.category || "-"}\n` +
      `📅 *Tanggal*: ${tx.occurred_at || "-"}\n\n` +
      `💰 *Saldo Dompet Saat Ini*: *${formatRupiah(balance)}*`;

    await ctx.editMessageText(resultText, { parse_mode: "Markdown" });
    await ctx.answerCallbackQuery({ text: "Transaksi berhasil dikonfirmasi!" });
  } else if (action === "cancel") {
    cancelTransaction(transactionId, walletId);

    const resultText =
      `❌ *Transaksi Dibatalkan*\n\n` +
      `Nominal *${formatRupiah(tx.amount)}* tidak dimasukkan ke dalam saldo.`;

    await ctx.editMessageText(resultText, { parse_mode: "Markdown" });
    await ctx.answerCallbackQuery({ text: "Transaksi dibatalkan." });
  }
}
