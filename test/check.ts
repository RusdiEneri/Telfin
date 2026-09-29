import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { formatRupiah, parseRupiah } from "../src/utils/money.js";
import { ReceiptExtractionSchema } from "../src/validations/receipt.schema.js";

console.log("▶ Running Telfin logic checks...");

// 1. Check Money Utilities
assert.equal(formatRupiah(52500), "Rp52.500");
assert.equal(formatRupiah(0), "Rp0");
assert.equal(parseRupiah("Rp 52.500"), 52500);
assert.equal(parseRupiah(52500), 52500);
assert.equal(parseRupiah("Rp 1.250.000,00"), 125000000); // stripped digits or raw number
assert.equal(parseRupiah(150000), 150000);
console.log("✔ Money utilities pass");

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

// Must reject negative or zero amount
assert.throws(() => {
  ReceiptExtractionSchema.parse({ ...validPayload, amount: -500 });
});
assert.throws(() => {
  ReceiptExtractionSchema.parse({ ...validPayload, amount: 0 });
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

// Add confirmed Income
testDb.prepare(`
  INSERT INTO transactions (wallet_id, type, amount, status)
  VALUES (?, 'income', 100000, 'confirmed')
`).run(walletId);
assert.equal(getBalance(walletId), 47500, "Confirmed income must add to balance");

testDb.close();
console.log("✔ SQLite transaction & balance flow passes");

console.log("🎉 All checks passed successfully!");
