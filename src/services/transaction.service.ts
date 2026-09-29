import db from "../db/index.js";
import type { ReceiptExtraction } from "../validations/receipt.schema.js";

export interface UserWallet {
  userId: number;
  walletId: number;
  telegramUserId: string;
  name: string;
}

export interface WalletRecord {
  id: number;
  user_id: number;
  name: string;
  currency: string;
  is_default: number;
  created_at: string;
}

export interface TransactionRecord {
  id: number;
  wallet_id: number;
  type: "income" | "expense";
  amount: number;
  merchant: string | null;
  category: string | null;
  note: string | null;
  occurred_at: string | null;
  status: "pending" | "confirmed" | "cancelled" | "deleted";
  source: string | null;
  file_hash: string | null;
  created_at: string;
}

export interface WalletBalance {
  balance: number;
  totalIncome: number;
  totalExpense: number;
}

export interface MonthlyRecap {
  yearMonth: string;
  totalIncome: number;
  totalExpense: number;
  netBalance: number;
  topCategories: Array<{ category: string; total: number }>;
}

export function getOrCreateUserAndWallet(telegramUserId: string, name?: string): UserWallet {
  const findUser = db.prepare("SELECT id, name FROM users WHERE telegram_user_id = ?");
  let user = findUser.get(telegramUserId) as { id: number; name: string } | undefined;

  if (!user) {
    const insertUser = db.prepare("INSERT INTO users (telegram_user_id, name) VALUES (?, ?)");
    const info = insertUser.run(telegramUserId, name || "User");
    user = { id: Number(info.lastInsertRowid), name: name || "User" };
  } else if (name && user.name !== name) {
    db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, user.id);
  }

  const findWallet = db.prepare("SELECT id FROM wallets WHERE user_id = ? AND is_default = 1 LIMIT 1");
  let wallet = findWallet.get(user.id) as { id: number } | undefined;

  if (!wallet) {
    const anyWallet = db.prepare("SELECT id FROM wallets WHERE user_id = ? ORDER BY id ASC LIMIT 1").get(user.id) as { id: number } | undefined;
    if (anyWallet) {
      db.prepare("UPDATE wallets SET is_default = 1 WHERE id = ?").run(anyWallet.id);
      wallet = anyWallet;
    } else {
      const insertWallet = db.prepare(
        "INSERT INTO wallets (user_id, name, currency, is_default) VALUES (?, 'Dompet Utama', 'IDR', 1)"
      );
      const info = insertWallet.run(user.id);
      wallet = { id: Number(info.lastInsertRowid) };
    }
  }

  return {
    userId: user.id,
    walletId: wallet.id,
    telegramUserId,
    name: user.name,
  };
}

export function getUserWallets(userId: number): WalletRecord[] {
  const query = db.prepare("SELECT * FROM wallets WHERE user_id = ? ORDER BY is_default DESC, id ASC");
  return query.all(userId) as WalletRecord[];
}

export function getWalletById(walletId: number): WalletRecord | undefined {
  const query = db.prepare("SELECT * FROM wallets WHERE id = ?");
  return query.get(walletId) as WalletRecord | undefined;
}

export function setDefaultWallet(
  userId: number,
  walletName: string
): { success: boolean; wallet?: WalletRecord } {
  const find = db.prepare("SELECT * FROM wallets WHERE user_id = ? AND LOWER(name) = LOWER(?) LIMIT 1");
  const target = find.get(userId, walletName.trim()) as WalletRecord | undefined;

  if (!target) {
    return { success: false };
  }

  db.transaction(() => {
    db.prepare("UPDATE wallets SET is_default = 0 WHERE user_id = ?").run(userId);
    db.prepare("UPDATE wallets SET is_default = 1 WHERE id = ?").run(target.id);
  })();

  return { success: true, wallet: { ...target, is_default: 1 } };
}

export function createWallet(userId: number, name: string): WalletRecord {
  const insert = db.prepare("INSERT INTO wallets (user_id, name, currency, is_default) VALUES (?, ?, 'IDR', 0)");
  const info = insert.run(userId, name.trim());
  return {
    id: Number(info.lastInsertRowid),
    user_id: userId,
    name: name.trim(),
    currency: "IDR",
    is_default: 0,
    created_at: new Date().toISOString(),
  };
}

export function updatePendingTransactionWallet(transactionId: number, walletId: number): boolean {
  const update = db.prepare(`
    UPDATE transactions
    SET wallet_id = ?
    WHERE id = ? AND status = 'pending'
  `);
  const result = update.run(walletId, transactionId);
  return result.changes > 0;
}

export function createPendingTransaction(
  walletId: number,
  data: ReceiptExtraction,
  imagePath?: string,
  fileHash?: string
): number {
  const insert = db.prepare(`
    INSERT INTO transactions (
      wallet_id,
      type,
      amount,
      merchant,
      category,
      note,
      occurred_at,
      status,
      source,
      file_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `);

  const info = insert.run(
    walletId,
    data.type,
    data.amount,
    data.merchant || null,
    data.category || "Lain-lain",
    data.note || null,
    data.occurred_at || new Date().toISOString().slice(0, 10),
    imagePath || null,
    fileHash || null
  );

  return Number(info.lastInsertRowid);
}

export function findConfirmedTransactionByHash(
  walletId: number,
  fileHash: string
): TransactionRecord | undefined {
  const query = db.prepare(`
    SELECT * FROM transactions
    WHERE wallet_id = ? AND file_hash = ? AND status = 'confirmed'
    LIMIT 1
  `);
  return query.get(walletId, fileHash) as TransactionRecord | undefined;
}

export function createManualTransaction(
  walletId: number,
  type: "income" | "expense",
  amount: number,
  note: string,
  category = "Manual"
): number {
  const insert = db.prepare(`
    INSERT INTO transactions (
      wallet_id,
      type,
      amount,
      note,
      category,
      occurred_at,
      status,
      source
    ) VALUES (?, ?, ?, ?, ?, ?, 'confirmed', 'manual')
  `);

  const info = insert.run(
    walletId,
    type,
    amount,
    note || null,
    category,
    new Date().toISOString().slice(0, 10)
  );

  return Number(info.lastInsertRowid);
}

export function confirmTransaction(transactionId: number, walletId: number): boolean {
  const update = db.prepare(`
    UPDATE transactions
    SET status = 'confirmed'
    WHERE id = ? AND wallet_id = ? AND status = 'pending'
  `);
  const result = update.run(transactionId, walletId);
  return result.changes > 0;
}

export function cancelTransaction(transactionId: number, walletId: number): boolean {
  const update = db.prepare(`
    UPDATE transactions
    SET status = 'cancelled'
    WHERE id = ? AND wallet_id = ? AND status = 'pending'
  `);
  const result = update.run(transactionId, walletId);
  return result.changes > 0;
}

export function softDeleteTransaction(transactionId: number, walletId: number): boolean {
  const update = db.prepare(`
    UPDATE transactions
    SET status = 'deleted'
    WHERE id = ? AND wallet_id = ? AND status = 'confirmed'
  `);
  const result = update.run(transactionId, walletId);
  return result.changes > 0;
}

export function updateTransaction(
  transactionId: number,
  walletId: number,
  amount: number,
  description: string
): boolean {
  const update = db.prepare(`
    UPDATE transactions
    SET amount = ?, note = ?, merchant = ?
    WHERE id = ? AND wallet_id = ? AND status = 'confirmed'
  `);
  const result = update.run(amount, description, description, transactionId, walletId);
  return result.changes > 0;
}

export function getTransactionById(id: number): TransactionRecord | undefined {
  const query = db.prepare("SELECT * FROM transactions WHERE id = ?");
  return query.get(id) as TransactionRecord | undefined;
}

export function getWalletBalance(walletId: number): WalletBalance {
  const query = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) AS total_income,
      COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS total_expense
    FROM transactions
    WHERE wallet_id = ? AND status = 'confirmed'
  `);

  const row = query.get(walletId) as { total_income: number; total_expense: number };
  const totalIncome = row ? Number(row.total_income) : 0;
  const totalExpense = row ? Number(row.total_expense) : 0;
  const balance = totalIncome - totalExpense;

  return { balance, totalIncome, totalExpense };
}

export const getBalance = getWalletBalance;

export function getRecentTransactions(walletId: number, limit = 5): TransactionRecord[] {
  const query = db.prepare(`
    SELECT * FROM transactions
    WHERE wallet_id = ? AND status = 'confirmed'
    ORDER BY id DESC
    LIMIT ?
  `);
  return query.all(walletId, limit) as TransactionRecord[];
}

export function getMonthlyRecap(walletId: number, yearMonth: string): MonthlyRecap {
  const summaryQuery = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) AS total_income,
      COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS total_expense
    FROM transactions
    WHERE wallet_id = ? AND status = 'confirmed'
      AND COALESCE(occurred_at, substr(created_at, 1, 10)) LIKE ? || '%'
  `);

  const summary = summaryQuery.get(walletId, yearMonth) as {
    total_income: number;
    total_expense: number;
  };

  const totalIncome = summary ? Number(summary.total_income) : 0;
  const totalExpense = summary ? Number(summary.total_expense) : 0;
  const netBalance = totalIncome - totalExpense;

  const topCatQuery = db.prepare(`
    SELECT category, SUM(amount) AS total
    FROM transactions
    WHERE wallet_id = ? AND status = 'confirmed' AND type = 'expense'
      AND COALESCE(occurred_at, substr(created_at, 1, 10)) LIKE ? || '%'
    GROUP BY category
    ORDER BY total DESC
    LIMIT 3
  `);

  const topCategories = (
    topCatQuery.all(walletId, yearMonth) as Array<{
      category: string;
      total: number;
    }>
  ).map((row) => ({
    category: row.category || "Lain-lain",
    total: Number(row.total),
  }));

  return {
    yearMonth,
    totalIncome,
    totalExpense,
    netBalance,
    topCategories,
  };
}
