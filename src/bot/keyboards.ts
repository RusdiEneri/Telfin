import { InlineKeyboard } from "grammy";

export function createTransactionConfirmationKeyboard(transactionId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Konfirmasi", `confirm:${transactionId}`)
    .text("❌ Batalkan", `cancel:${transactionId}`);
}
