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

export function createBot(token: string): Bot {
  const bot = new Bot(token);

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