import { InlineKeyboard } from "grammy";

export function createTransactionConfirmationKeyboard(transactionId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Konfirmasi", `confirm:${transactionId}`)
    .text("❌ Batalkan", `cancel:${transactionId}`)
    .row()
    .text("💳 Ubah Dompet", `change_wallet_${transactionId}`);
}

export function createWalletSelectionKeyboard(
  pendingId: number,
  wallets: Array<{ id: number; name: string; is_default: number }>,
  currentWalletId?: number
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const w of wallets) {
    const isSelected = w.id === currentWalletId;
    const label = `${isSelected ? "🔘 " : ""}${w.name}${w.is_default ? " (Utama)" : ""}`;
    keyboard.text(label, `set_wallet_${pendingId}_${w.id}`).row();
  }
  keyboard.text("🔙 Kembali", `back_preview_${pendingId}`);
  return keyboard;
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

export function createImportConfirmationKeyboard(importId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Ya, Import", `confirm_import:${importId}`)
    .text("❌ Batal", `cancel_import:${importId}`);
}

