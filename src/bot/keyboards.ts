import { InlineKeyboard } from "grammy";

export function createTransactionConfirmationKeyboard(transactionId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Konfirmasi", `confirm:${transactionId}`)
    .text("❌ Batalkan", `cancel:${transactionId}`);
}

export function createTransactionActionKeyboard(transactionId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("✏️ Edit", `edit_${transactionId}`)
    .text("🗑️ Hapus", `delete_${transactionId}`);
}

export function createDeleteConfirmationKeyboard(transactionId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Ya, Hapus", `confirm_delete_${transactionId}`)
    .text("❌ Batal", `cancel_delete_${transactionId}`);
}
