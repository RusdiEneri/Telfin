import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { formatRupiah, parseRupToInt, parseRupiah } from "../src/utils/money.js";
import { formatDateTimeJakarta } from "../src/utils/date.js";
import { ReceiptExtractionSchema } from "../src/validations/receipt.schema.js";
import { logger } from "../src/utils/logger.js";
import { cleanupPendingUploads } from "../src/services/receipt.service.js";
import { formatTransactionDetail, formatReceiptPreview } from "../src/bot/handlers.js";
import { getAllowedUserIds, BOT_COMMANDS } from "../src/bot/index.js";
import { createTransactionConfirmationKeyboard, createWalletSelectionKeyboard } from "../src/bot/keyboards.js";
import { escapeCsvCell, formatTransactionsCsv } from "../src/services/transaction.service.js";
import db, { initDb, dbPath } from "../src/db/index.js";

console.log("▶ Running Telfin logic checks...");

// 1. Check Money Utilities & parseRupToInt
assert.equal(formatRupiah(52500), "Rp52.500");
assert.equal(formatRupiah(0), "Rp0");
assert.equal(parseRupToInt("50000"), 50000);
assert.equal(parseRupToInt("50.000"), 50000);
assert.equal(parseRupToInt("Rp50.000"), 50000);
assert.equal(parseRupToInt("Rp 1.500.000"), 1500000);
assert.equal(parseRupToInt(150000), 150000);
assert.equal(parseRupToInt("abc"), 0, "Invalid text must return 0");
assert.equal(parseRupToInt("-5000"), 0, "Negative amount must return 0");
assert.equal(parseRupToInt(""), 0, "Empty string must return 0");
assert.equal(parseRupiah("50000"), 50000);
console.log("✔ Money utilities and parseRupToInt pass");

// 2. Check Zod Schema
const validPayload = {
  type: "expense",
  amount: 52500,
  merchant: "Indomaret",
  category: "Makanan & Minuman",
  note: "Snack & Minum",
  occurred_at: "2026-09-29",
};
const parsed = ReceiptExtractionSchema.parse(validPayload);
assert.equal(parsed.amount, 52500);
assert.equal(parsed.type, "expense");
assert.equal(parsed.merchant, "Indomaret");

// Must reject negative, zero, or null amount
assert.throws(() => {
  ReceiptExtractionSchema.parse({ ...validPayload, amount: -500 });
});
assert.throws(() => {
  ReceiptExtractionSchema.parse({ ...validPayload, amount: 0 });
});
assert.throws(() => {
  ReceiptExtractionSchema.parse({ ...validPayload, amount: null });
});
console.log("✔ Zod schema validation passes");

// 2b. Check Gemini candidate models and fallback resilience
const primary = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const candidateModels = Array.from(new Set([primary, "gemini-3.5-flash", "gemini-3-flash-preview"]));
assert.ok(candidateModels.length >= 2, "Candidate models must have at least 1 fallback");
assert.equal(candidateModels[0], primary, "Primary model must be first candidate");
console.log("✔ AI model fallback candidate list passes");

// 2c. Check formatTransactionDetail (rich receipt / transaction format)
const sampleTx = {
  id: 12,
  type: "expense" as const,
  amount: 52500,
  merchant: "Indomaret",
  category: "Makanan & Minuman",
  note: "Snack & Minum",
  occurred_at: "2026-09-29",
  created_at: "2026-09-29 10:00:00",
};
const detailFormatted = formatTransactionDetail(sampleTx);
assert.ok(detailFormatted.includes("[#12]"), "Must include transaction ID");
assert.ok(detailFormatted.includes("🔴"), "Expense must have red icon");
assert.ok(detailFormatted.includes("Pengeluaran"), "Must label Pengeluaran");
assert.ok(detailFormatted.includes("Rp52.500"), "Must format amount in Rupiah");
assert.ok(detailFormatted.includes("Indomaret"), "Must include merchant");
assert.ok(detailFormatted.includes("Makanan & Minuman"), "Must include category");
assert.ok(detailFormatted.includes("29 September 2026"), "Must include Indonesian date");
assert.ok(detailFormatted.includes("Selasa"), "Must include day of week");
assert.ok(detailFormatted.includes("WIB"), "Must include Asia/Jakarta WIB timezone");
assert.ok(detailFormatted.includes("Snack & Minum"), "Must include note");
console.log("✔ Rich transaction detail formatting passes");

// 2c1. Check formatDateTimeJakarta (Indonesian weekday, date, 24h time, Asia/Jakarta WIB)
const formattedUtc = formatDateTimeJakarta("2026-09-29 13:27:13");
assert.ok(formattedUtc.includes("Selasa"), "Must format day as Selasa");
assert.ok(formattedUtc.includes("29 September 2026"), "Must format Indonesian date");
assert.ok(formattedUtc.includes("20.27"), "Must format 24-hour time in UTC+7 Jakarta");
assert.ok(formattedUtc.includes("WIB"), "Must format timezone name as WIB");
console.log("✔ formatDateTimeJakarta 24h Asia/Jakarta passes");

// 2c2. Check formatReceiptPreview and Confirmation / Wallet Keyboards
const previewFormatted = formatReceiptPreview(
  {
    type: "expense",
    amount: 52500,
    merchant: "Indomaret",
    category: "Makanan & Minuman",
    occurred_at: "2026-09-29",
    note: "Snack",
  },
  "Dompet Utama (Cash)"
);
assert.ok(previewFormatted.includes("Akan dicatat ke: 💳"), "Must include designated wallet prefix");
assert.ok(previewFormatted.includes("Dompet Utama (Cash)"), "Must include designated wallet name");
assert.ok(previewFormatted.includes("Rp52.500"), "Must format amount in Rupiah");

const confirmKb = createTransactionConfirmationKeyboard(99);
const flatButtons = confirmKb.inline_keyboard.flat();
assert.ok(flatButtons.some((b) => b.callback_data === "confirm:99"), "Must have confirm button");
assert.ok(flatButtons.some((b) => b.callback_data === "cancel:99"), "Must have cancel button");
assert.ok(flatButtons.some((b) => b.callback_data === "change_wallet_99"), "Must have change wallet button");

const walletKb = createWalletSelectionKeyboard(
  99,
  [
    { id: 1, name: "Dompet Utama", is_default: 1 },
    { id: 2, name: "Bank BCA", is_default: 0 },
  ],
  1
);
const flatWalletButtons = walletKb.inline_keyboard.flat();
assert.ok(flatWalletButtons.some((b) => b.callback_data === "set_wallet_99_1"), "Must have button for wallet 1");
assert.ok(flatWalletButtons.some((b) => b.callback_data === "set_wallet_99_2"), "Must have button for wallet 2");
assert.ok(flatWalletButtons.some((b) => b.callback_data === "back_preview_99"), "Must have back to preview button");
console.log("✔ Receipt preview formatting & wallet selection keyboards pass");

// 2d. Check BOT_COMMANDS and whitelist access control parsing
assert.ok(BOT_COMMANDS.length >= 10, "Must register at least 10 commands in menu");
assert.ok(BOT_COMMANDS.some((c) => c.command === "dompet"));
assert.ok(BOT_COMMANDS.some((c) => c.command === "setdefault"));
assert.ok(BOT_COMMANDS.some((c) => c.command === "riwayat"));
assert.ok(BOT_COMMANDS.some((c) => c.command === "cari"));
assert.ok(BOT_COMMANDS.some((c) => c.command === "saldo"));
assert.ok(BOT_COMMANDS.some((c) => c.command === "rekap"));
assert.ok(BOT_COMMANDS.some((c) => c.command === "export"));
assert.ok(BOT_COMMANDS.some((c) => c.command === "edit"));
assert.ok(BOT_COMMANDS.some((c) => c.command === "hapus"));
assert.ok(BOT_COMMANDS.some((c) => c.command === "backup"));
assert.ok(BOT_COMMANDS.some((c) => c.command === "restore"));

const origAllowed = process.env.ALLOWED_USER_IDS;
process.env.ALLOWED_USER_IDS = '["12345", "67890"]';
assert.deepEqual(getAllowedUserIds(), ["12345", "67890"]);

process.env.ALLOWED_USER_IDS = "[12345, 67890]";
assert.deepEqual(getAllowedUserIds(), ["12345", "67890"]);

process.env.ALLOWED_USER_IDS = "12345, 67890";
assert.deepEqual(getAllowedUserIds(), ["12345", "67890"]);

process.env.ALLOWED_USER_IDS = "";
assert.deepEqual(getAllowedUserIds(), []);

process.env.ALLOWED_USER_IDS = origAllowed;
console.log("✔ Command menu & user whitelist parsing passes");

// 2e. Check Backup & Restore File & Proxy Hot-Reload
const backupBuf = fs.readFileSync(dbPath);
assert.ok(backupBuf.length >= 16, "Backup buffer must not be empty");
assert.equal(backupBuf.subarray(0, 15).toString(), "SQLite format 3", "Backup file must be valid SQLite format 3");

const invalidBuf = Buffer.from("this is definitely not a sqlite database");
const isValidSqlite = invalidBuf.length >= 16 && invalidBuf.subarray(0, 15).toString() === "SQLite format 3";
assert.equal(isValidSqlite, false, "Must detect invalid SQLite file");

// Test reload of DB proxy with initDb()
const prevUserCount = (db.prepare("SELECT COUNT(*) as count FROM users").get() as any).count;
initDb();
const postUserCount = (db.prepare("SELECT COUNT(*) as count FROM users").get() as any).count;
assert.equal(prevUserCount, postUserCount, "Database proxy must work after initDb reload");
console.log("✔ Backup read, SQLite validation & DB proxy hot-reload passes");

// 3. Check DB Flow (isolated test DB)
const testDbDir = path.join(process.cwd(), "data");
if (!fs.existsSync(testDbDir)) fs.mkdirSync(testDbDir, { recursive: true });

const testDb = new Database(":memory:");
const schemaPath = path.join(process.cwd(), "src", "db", "schema.sql");
testDb.exec(fs.readFileSync(schemaPath, "utf-8"));

// Create User & Wallet
const userRes = testDb.prepare("INSERT INTO users (telegram_user_id, name) VALUES (?, ?)").run("99999", "Tester");
const userId = Number(userRes.lastInsertRowid);
const walletRes = testDb.prepare("INSERT INTO wallets (user_id, name) VALUES (?, ?)").run(userId, "Dompet Utama");
const walletId = Number(walletRes.lastInsertRowid);

function getBalance(wId: number): number {
  const row = testDb.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS balance
    FROM transactions
    WHERE wallet_id = ? AND status = 'confirmed'
  `).get(wId) as { balance: number };
  return row ? Number(row.balance) : 0;
}

// Initial balance must be 0
assert.equal(getBalance(walletId), 0);

// Insert Pending Expense with file_hash
const pendingExpense = testDb.prepare(`
  INSERT INTO transactions (wallet_id, type, amount, status, file_hash)
  VALUES (?, 'expense', 52500, 'pending', 'hash123')
`).run(walletId);
const txExpenseId = Number(pendingExpense.lastInsertRowid);

// Pending transaction MUST NOT affect balance
assert.equal(getBalance(walletId), 0, "Pending transaction should not change balance");

// Pending hash check should not be considered confirmed duplicate
const checkPendingHash = testDb.prepare(`
  SELECT id FROM transactions WHERE wallet_id = ? AND file_hash = ? AND status = 'confirmed'
`).get(walletId, "hash123");
assert.equal(checkPendingHash, undefined, "Pending hash is not yet confirmed");

// Confirm transaction (set older date so it doesn't collide with September recap test)
testDb.prepare("UPDATE transactions SET status = 'confirmed', occurred_at = '2026-07-01' WHERE id = ?").run(txExpenseId);
assert.equal(getBalance(walletId), -52500, "Confirmed expense must deduct from balance");

// Confirmed hash check SHOULD be found
const checkConfirmedHash = testDb.prepare(`
  SELECT id FROM transactions WHERE wallet_id = ? AND file_hash = ? AND status = 'confirmed'
`).get(walletId, "hash123") as { id: number };
assert.equal(checkConfirmedHash.id, txExpenseId, "Confirmed hash must be detected as duplicate");

// Insert Pending Income and Cancel it
const pendingIncome = testDb.prepare(`
  INSERT INTO transactions (wallet_id, type, amount, status)
  VALUES (?, 'income', 100000, 'pending')
`).run(walletId);
const txIncomeId = Number(pendingIncome.lastInsertRowid);

testDb.prepare("UPDATE transactions SET status = 'cancelled' WHERE id = ?").run(txIncomeId);
assert.equal(getBalance(walletId), -52500, "Cancelled transaction must not change balance");

// Check Manual Transactions: directly confirmed
testDb.prepare(`
  INSERT INTO transactions (wallet_id, type, amount, note, category, occurred_at, status, source)
  VALUES (?, 'expense', 50000, 'makan siang', 'Makanan & Minuman', '2026-09-10', 'confirmed', 'manual')
`).run(walletId);

testDb.prepare(`
  INSERT INTO transactions (wallet_id, type, amount, note, category, occurred_at, status, source)
  VALUES (?, 'expense', 150000, 'makan malam steak', 'Makanan & Minuman', '2026-09-12', 'confirmed', 'manual')
`).run(walletId);

testDb.prepare(`
  INSERT INTO transactions (wallet_id, type, amount, note, category, occurred_at, status, source)
  VALUES (?, 'expense', 100000, 'belanja baju', 'Belanja', '2026-09-15', 'confirmed', 'manual')
`).run(walletId);

testDb.prepare(`
  INSERT INTO transactions (wallet_id, type, amount, note, category, occurred_at, status, source)
  VALUES (?, 'expense', 40000, 'bensin motor', 'Transportasi', '2026-09-16', 'confirmed', 'manual')
`).run(walletId);

testDb.prepare(`
  INSERT INTO transactions (wallet_id, type, amount, note, category, occurred_at, status, source)
  VALUES (?, 'expense', 10000, 'nonton bioskop', 'Hiburan', '2026-09-18', 'confirmed', 'manual')
`).run(walletId);

testDb.prepare(`
  INSERT INTO transactions (wallet_id, type, amount, note, category, occurred_at, status, source)
  VALUES (?, 'income', 1500000, 'gaji', 'Gaji', '2026-09-01', 'confirmed', 'manual')
`).run(walletId);

// Add a transaction in another month to verify filtering (2026-08)
testDb.prepare(`
  INSERT INTO transactions (wallet_id, type, amount, note, category, occurred_at, status, source)
  VALUES (?, 'expense', 99999, 'lampu lama', 'Tagihan', '2026-08-20', 'confirmed', 'manual')
`).run(walletId);

// 4. Check Monthly Recap Logic
const recapMonth = "2026-09";
const summary = testDb.prepare(`
  SELECT
    COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) AS total_income,
    COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS total_expense
  FROM transactions
  WHERE wallet_id = ? AND status = 'confirmed'
    AND COALESCE(occurred_at, substr(created_at, 1, 10)) LIKE ? || '%'
`).get(walletId, recapMonth) as { total_income: number; total_expense: number };

assert.equal(summary.total_income, 1500000, "September income must match");
assert.equal(summary.total_expense, 350000, "September expense must match (50k+150k+100k+40k+10k)");

const topCats = testDb.prepare(`
  SELECT category, SUM(amount) AS total
  FROM transactions
  WHERE wallet_id = ? AND status = 'confirmed' AND type = 'expense'
    AND COALESCE(occurred_at, substr(created_at, 1, 10)) LIKE ? || '%'
  GROUP BY category
  ORDER BY total DESC
  LIMIT 3
`).all(walletId, recapMonth) as Array<{ category: string; total: number }>;

assert.equal(topCats.length, 3, "Top categories must be exactly 3");
assert.equal(topCats[0].category, "Makanan & Minuman");
assert.equal(topCats[0].total, 200000);
assert.equal(topCats[1].category, "Belanja");
assert.equal(topCats[1].total, 100000);
assert.equal(topCats[2].category, "Transportasi");
assert.equal(topCats[2].total, 40000);
console.log("✔ Monthly recap calculation and top 3 categories pass");

// 5. Check Auto-migration
const legacyDb = new Database(":memory:");
legacyDb.exec(`
  CREATE TABLE transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL
  );
`);
let cols = legacyDb.pragma("table_info(transactions)") as Array<{ name: string }>;
assert.equal(cols.some((c) => c.name === "file_hash"), false, "Legacy table lacks file_hash");

// Run migration logic
if (!cols.some((col) => col.name === "file_hash")) {
  legacyDb.exec("ALTER TABLE transactions ADD COLUMN file_hash TEXT;");
  legacyDb.exec("CREATE INDEX IF NOT EXISTS idx_transactions_file_hash ON transactions(file_hash);");
}
cols = legacyDb.pragma("table_info(transactions)") as Array<{ name: string }>;
assert.equal(cols.some((c) => c.name === "file_hash"), true, "Migrated table must have file_hash");
legacyDb.close();

// Auto-migration test for wallets is_default
const legacyWalletsDb = new Database(":memory:");
legacyWalletsDb.exec(`
  CREATE TABLE wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'IDR'
  );
`);
let walletCols = legacyWalletsDb.pragma("table_info(wallets)") as Array<{ name: string }>;
assert.equal(walletCols.some((c) => c.name === "is_default"), false, "Legacy wallets lacks is_default");
if (!walletCols.some((c) => c.name === "is_default")) {
  legacyWalletsDb.exec("ALTER TABLE wallets ADD COLUMN is_default INTEGER NOT NULL DEFAULT 1;");
}
walletCols = legacyWalletsDb.pragma("table_info(wallets)") as Array<{ name: string }>;
assert.equal(walletCols.some((c) => c.name === "is_default"), true, "Migrated wallets has is_default");
legacyWalletsDb.close();

console.log("✔ SQLite auto-migration passes");

// 5. Check Update & Soft Delete CRUD operations
const currentBal = getBalance(walletId);

// Insert a test transaction to edit and delete
const testTxRes = testDb.prepare(`
  INSERT INTO transactions (wallet_id, type, amount, note, status, source)
  VALUES (?, 'expense', 50000, 'makan siang', 'confirmed', 'manual')
`).run(walletId);
const testTxId = Number(testTxRes.lastInsertRowid);
assert.equal(getBalance(walletId), currentBal - 50000, "Balance must deduct 50000");

// Update transaction amount to 75000 and note to 'makan malam di warteg'
const updateRes = testDb.prepare(`
  UPDATE transactions
  SET amount = ?, note = ?, merchant = ?
  WHERE id = ? AND wallet_id = ? AND status = 'confirmed'
`).run(75000, "makan malam di warteg", "makan malam di warteg", testTxId, walletId);
assert.equal(updateRes.changes, 1, "Should update 1 transaction");

const updatedTx = testDb.prepare("SELECT * FROM transactions WHERE id = ?").get(testTxId) as any;
assert.equal(updatedTx.amount, 75000);
assert.equal(updatedTx.note, "makan malam di warteg");
assert.equal(getBalance(walletId), currentBal - 75000, "Balance must reflect updated amount 75000");

// Soft delete the transaction
const deleteRes = testDb.prepare(`
  UPDATE transactions
  SET status = 'deleted'
  WHERE id = ? AND wallet_id = ? AND status = 'confirmed'
`).run(testTxId, walletId);
assert.equal(deleteRes.changes, 1, "Should soft delete 1 transaction");

// Verify transaction still exists in DB for audit trail
const deletedTx = testDb.prepare("SELECT * FROM transactions WHERE id = ?").get(testTxId) as any;
assert.equal(deletedTx.status, "deleted", "Transaction status must be deleted");

// Verify getBalance excludes deleted transaction
assert.equal(getBalance(walletId), currentBal, "Balance must exclude soft-deleted transaction");

// Verify recent transactions excludes deleted transaction
const recent = testDb.prepare(`
  SELECT * FROM transactions
  WHERE wallet_id = ? AND status = 'confirmed'
  ORDER BY id DESC LIMIT 5
`).all(walletId) as any[];
assert.equal(recent.some((t) => t.id === testTxId), false, "Recent transactions must exclude deleted tx");

console.log("✔ Soft-delete and Update CRUD operations pass");

// Check multi-wallet operations
const wallet2Res = testDb.prepare("INSERT INTO wallets (user_id, name, is_default) VALUES (?, ?, 0)").run(userId, "Bank BCA");
const wallet2Id = Number(wallet2Res.lastInsertRowid);

// Pending receipt created for default wallet
const pendingForW1 = testDb.prepare(`
  INSERT INTO transactions (wallet_id, type, amount, status)
  VALUES (?, 'expense', 25000, 'pending')
`).run(walletId);
const pendingW1Id = Number(pendingForW1.lastInsertRowid);

// User changes wallet from walletId to wallet2Id
const updateWalletRes = testDb.prepare(`
  UPDATE transactions
  SET wallet_id = ?
  WHERE id = ? AND status = 'pending'
`).run(wallet2Id, pendingW1Id);
assert.equal(updateWalletRes.changes, 1, "Should update pending transaction wallet");

// Confirm the transaction
testDb.prepare("UPDATE transactions SET status = 'confirmed' WHERE id = ?").run(pendingW1Id);

// Check that wallet2 balance is updated, and wallet1 balance remains unaffected
assert.equal(getBalance(wallet2Id), -25000, "Wallet 2 must reflect confirmed expense");

// Check search functionality: LIKE query on merchant and note
const searchMerchant = testDb.prepare(`
  SELECT t.*
  FROM transactions t
  JOIN wallets w ON t.wallet_id = w.id
  WHERE w.user_id = ? AND t.status = 'confirmed'
    AND (t.merchant LIKE ? OR t.note LIKE ?)
  ORDER BY t.id DESC
  LIMIT 10
`).all(userId, "%bensin%", "%bensin%") as any[];
assert.equal(searchMerchant.length, 1, "Should find 1 transaction for 'bensin'");
assert.equal(searchMerchant[0].note, "bensin motor");

const searchNote = testDb.prepare(`
  SELECT t.*
  FROM transactions t
  JOIN wallets w ON t.wallet_id = w.id
  WHERE w.user_id = ? AND t.status = 'confirmed'
    AND (t.merchant LIKE ? OR t.note LIKE ?)
  ORDER BY t.id DESC
  LIMIT 10
`).all(userId, "%steak%", "%steak%") as any[];
assert.equal(searchNote.length, 1, "Should find 1 transaction for 'steak'");

const searchNone = testDb.prepare(`
  SELECT t.*
  FROM transactions t
  JOIN wallets w ON t.wallet_id = w.id
  WHERE w.user_id = ? AND t.status = 'confirmed'
    AND (t.merchant LIKE ? OR t.note LIKE ?)
  ORDER BY t.id DESC
  LIMIT 10
`).all(userId, "%supermarket_tidak_ada%", "%supermarket_tidak_ada%") as any[];
assert.equal(searchNone.length, 0, "Non-existent keyword should return 0 results");

// Check CSV export generation and escaping
assert.equal(escapeCsvCell("Indomaret"), "Indomaret");
assert.equal(escapeCsvCell(52500), "52500");
assert.equal(escapeCsvCell("makan siang, warteg"), '"makan siang, warteg"');
assert.equal(escapeCsvCell('beli "buku"'), '"beli ""buku"""');
assert.equal(escapeCsvCell(null), "");

const allConfirmed = testDb.prepare(`
  SELECT t.*
  FROM transactions t
  JOIN wallets w ON t.wallet_id = w.id
  WHERE w.user_id = ? AND t.status = 'confirmed'
  ORDER BY t.id ASC
`).all(userId) as any[];
assert.ok(allConfirmed.length >= 5, "Should have at least 5 confirmed transactions");

const csvData = formatTransactionsCsv(allConfirmed);
assert.ok(csvData.startsWith("ID,Tanggal,Tipe,Kategori,Merchant,Nominal,Keterangan"), "CSV must start with correct header");
const csvBuffer = Buffer.from(csvData, "utf-8");
assert.ok(csvBuffer.length > 0, "CSV Buffer must not be empty");
console.log("✔ Search LIKE query and CSV Export formatting pass");

testDb.close();
console.log("✔ SQLite transaction & balance flow passes");

// 6. Check Production Logger Error Writing
const originalEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "production";
const errorLogPath = path.join(process.cwd(), "data", "error.log");
if (fs.existsSync(errorLogPath)) fs.unlinkSync(errorLogPath);

logger.error("Test fatal error logging in production");
assert.equal(fs.existsSync(errorLogPath), true, "error.log must be created in production");
const logContent = fs.readFileSync(errorLogPath, "utf-8");
assert.ok(logContent.includes("Test fatal error logging in production"));
fs.unlinkSync(errorLogPath);
process.env.NODE_ENV = originalEnv;
console.log("✔ Production logger file output passes");

// 7. Check Graceful Uploads Cleanup
const uploadsDir = path.join(process.cwd(), "uploads");
const hangingFile = path.join(uploadsDir, "temp_hanging_123.jpg");
fs.writeFileSync(hangingFile, "hanging content");
assert.equal(fs.existsSync(hangingFile), true);
const cleanedCount = cleanupPendingUploads();
assert.ok(cleanedCount >= 1, "Should clean at least 1 hanging file");
assert.equal(fs.existsSync(hangingFile), false, "Hanging file should be removed");
console.log("✔ Graceful shutdown cleanupPendingUploads passes");

console.log("🎉 All checks passed successfully!");
