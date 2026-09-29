import { Bot } from "grammy";
import {
  handleStart,
  handleSaldo,
  handleRiwayat,
  handleHelp,
  handlePhoto,
  handleCallbackQuery,
} from "./handlers.js";

export function createBot(token: string): Bot {
  const bot = new Bot(token);

  bot.command("start", handleStart);
  bot.command("saldo", handleSaldo);
  bot.command("riwayat", handleRiwayat);
  bot.command("help", handleHelp);

  bot.on(":photo", handlePhoto);
  bot.on("callback_query:data", handleCallbackQuery);

  return bot;
}