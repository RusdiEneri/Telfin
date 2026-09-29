import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { formatRupiah, parseRupToInt, parseRupiah } from "../src/utils/money.js";
import { ReceiptExtractionSchema } from "../src/validations/receipt.schema.js";
import { logger } from "../src/utils/logger.js";
import { cleanupPendingUploads } from "../src/services/receipt.service.js";

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
console.log("✔ SQLite auto-migration passes");

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
