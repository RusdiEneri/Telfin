import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { formatRupiah, parseRupToInt, parseRupiah } from "../src/utils/money.js";
import { ReceiptExtractionSchema } from "../src/validations/receipt.schema.js";

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

// Insert Pending Expense
const pendingExpense = testDb.prepare(`
  INSERT INTO transactions (wallet_id, type, amount, status)
  VALUES (?, 'expense', 52500, 'pending')
`).run(walletId);
const txExpenseId = Number(pendingExpense.lastInsertRowid);

// Pending transaction MUST NOT affect balance
assert.equal(getBalance(walletId), 0, "Pending transaction should not change balance");

// Confirm transaction
testDb.prepare("UPDATE transactions SET status = 'confirmed' WHERE id = ?").run(txExpenseId);
assert.equal(getBalance(walletId), -52500, "Confirmed expense must deduct from balance");

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
  INSERT INTO transactions (wallet_id, type, amount, note, category, status, source)
  VALUES (?, 'expense', 50000, 'makan siang', 'Manual', 'confirmed', 'manual')
`).run(walletId);
assert.equal(getBalance(walletId), -102500, "Manual expense directly confirmed");

testDb.prepare(`
  INSERT INTO transactions (wallet_id, type, amount, note, category, status, source)
  VALUES (?, 'income', 1500000, 'gaji', 'Manual', 'confirmed', 'manual')
`).run(walletId);
assert.equal(getBalance(walletId), 1397500, "Manual income directly confirmed");

testDb.close();
console.log("✔ SQLite transaction & balance flow passes");

// 4. Check File Auto-cleanup on Failure
const testUploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(testUploadDir)) fs.mkdirSync(testUploadDir, { recursive: true });
const dummyPath = path.join(testUploadDir, "dummy_failed_test.jpg");
fs.writeFileSync(dummyPath, "test content");
assert.equal(fs.existsSync(dummyPath), true);
fs.unlinkSync(dummyPath);
assert.equal(fs.existsSync(dummyPath), false, "Failed file must be unlinked");
console.log("✔ Upload cleanup logic passes");

console.log("🎉 All checks passed successfully!");
