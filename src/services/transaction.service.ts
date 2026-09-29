import db from "../db/index.js";
import type { ReceiptExtraction } from "../validations/receipt.schema.js";
import { parseRupToInt } from "../utils/money.js";

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
  topCategories: Array<{ category: string; total: number; percentage: number }>;
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
    LIMIT 5
  `);

  const topCategories = (
    topCatQuery.all(walletId, yearMonth) as Array<{
      category: string;
      total: number;
    }>
  ).map((row) => {
    const total = Number(row.total);
    const percentage = totalExpense > 0 ? Math.round((total / totalExpense) * 100) : 0;
    return {
      category: row.category || "Lain-lain",
      total,
      percentage,
    };
  });

  return {
    yearMonth,
    totalIncome,
    totalExpense,
    netBalance,
    topCategories,
  };
}

export function searchTransactions(
  userId: number,
  keyword: string,
  limit = 10
): TransactionRecord[] {
  const query = db.prepare(`
    SELECT t.*
    FROM transactions t
    JOIN wallets w ON t.wallet_id = w.id
    WHERE w.user_id = ? AND t.status = 'confirmed'
      AND (t.merchant LIKE ? OR t.note LIKE ?)
    ORDER BY t.id DESC
    LIMIT ?
  `);
  const pattern = `%${keyword.trim()}%`;
  return query.all(userId, pattern, pattern, limit) as TransactionRecord[];
}

export function getAllConfirmedTransactions(userId: number): TransactionRecord[] {
  const query = db.prepare(`
    SELECT t.*
    FROM transactions t
    JOIN wallets w ON t.wallet_id = w.id
    WHERE w.user_id = ? AND t.status = 'confirmed'
    ORDER BY t.id ASC
  `);
  return query.all(userId) as TransactionRecord[];
}

export function escapeCsvCell(val: string | number | null | undefined): string {
  if (val == null) return "";
  const str = String(val);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function formatTransactionsCsv(transactions: TransactionRecord[]): string {
  const header = "ID,Tanggal,Tipe,Kategori,Merchant,Nominal,Keterangan";
  const rows = transactions.map((tx) => {
    const tanggal = tx.occurred_at || tx.created_at.slice(0, 10);
    return [
      escapeCsvCell(tx.id),
      escapeCsvCell(tanggal),
      escapeCsvCell(tx.type),
      escapeCsvCell(tx.category || ""),
      escapeCsvCell(tx.merchant || ""),
      escapeCsvCell(tx.amount),
      escapeCsvCell(tx.note || ""),
    ].join(",");
  });
  return [header, ...rows].join("\n");
}

export function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++; // skip escaped double quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

export interface ParsedImportTransaction {
  type: "income" | "expense";
  amount: number;
  merchant?: string | null;
  category?: string | null;
  note?: string | null;
  occurred_at?: string | null;
}

export function parseCsvTransactions(csvContent: string): {
  valid: ParsedImportTransaction[];
  skipped: number;
  totalRows: number;
} {
  const cleanContent = csvContent.replace(/^\uFEFF/, "").trim();
  if (!cleanContent) {
    return { valid: [], skipped: 0, totalRows: 0 };
  }

  const lines = cleanContent.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) {
    return { valid: [], skipped: 0, totalRows: 0 };
  }

  let startIndex = 0;
  const firstRow = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const hasHeader = firstRow.some((col) => col.includes("tanggal") || col.includes("nominal") || col.includes("tipe"));

  // Default column mappings: ID=0, Tanggal=1, Tipe=2, Kategori=3, Merchant=4, Nominal=5, Keterangan=6
  let colDate = 1;
  let colType = 2;
  let colCategory = 3;
  let colMerchant = 4;
  let colAmount = 5;
  let colNote = 6;

  if (hasHeader) {
    startIndex = 1;
    const findCol = (name: string, fallback: number) => {
      const idx = firstRow.findIndex((c) => c.includes(name));
      return idx >= 0 ? idx : fallback;
    };
    colDate = findCol("tanggal", 1);
    colType = findCol("tipe", 2);
    colCategory = findCol("kategori", 3);
    colMerchant = findCol("merchant", 4);
    colAmount = findCol("nominal", 5);
    colNote = findCol("keterangan", 6);
  }

  const valid: ParsedImportTransaction[] = [];
  let skipped = 0;
  const dataLines = lines.slice(startIndex);

  for (const line of dataLines) {
    const cols = parseCsvLine(line);
    if (cols.length < 2) {
      skipped++;
      continue;
    }

    const rawAmount = cols[colAmount] !== undefined ? cols[colAmount] : "";
    const amount = parseRupToInt(rawAmount);
    if (amount <= 0) {
      skipped++;
      continue;
    }

    const rawType = (cols[colType] || "").toLowerCase().trim();
    let type: "income" | "expense";
    if (["expense", "pengeluaran", "keluar"].includes(rawType)) {
      type = "expense";
    } else if (["income", "pemasukan", "masuk"].includes(rawType)) {
      type = "income";
    } else {
      skipped++;
      continue;
    }

    const rawDate = (cols[colDate] || "").trim();
    const occurredAt = /^\d{4}-\d{2}-\d{2}/.test(rawDate)
      ? rawDate.slice(0, 10)
      : new Date().toISOString().slice(0, 10);

    const category = cols[colCategory]?.trim() || (type === "expense" ? "Umum" : "Pemasukan");
    const merchant = cols[colMerchant]?.trim() || null;
    const note = cols[colNote]?.trim() || null;

    valid.push({
      type,
      amount,
      merchant,
      category,
      note,
      occurred_at: occurredAt,
    });
  }

  return {
    valid,
    skipped,
    totalRows: dataLines.length,
  };
}

export function importTransactionsBulk(
  walletId: number,
  transactions: ParsedImportTransaction[]
): number {
  if (transactions.length === 0) return 0;

  const insertStmt = db.prepare(`
    INSERT INTO transactions (
      wallet_id,
      type,
      amount,
      merchant,
      category,
      note,
      occurred_at,
      status,
      source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', 'import')
  `);

  const insertBulk = db.transaction((rows: ParsedImportTransaction[]) => {
    let count = 0;
    for (const r of rows) {
      insertStmt.run(
        walletId,
        r.type,
        r.amount,
        r.merchant || null,
        r.category || null,
        r.note || null,
        r.occurred_at || null
      );
      count++;
    }
    return count;
  });

  return insertBulk(transactions);
}

export interface BudgetRecord {
  id: number;
  wallet_id: number;
  category: string;
  amount_limit: number;
  month_year: string;
  created_at: string;
}

export interface BudgetReportItem {
  id: number;
  wallet_id: number;
  category: string;
  amount_limit: number;
  month_year: string;
  total_spent: number;
}

export function setBudget(
  walletId: number,
  category: string,
  amountLimit: number,
  monthYear: string
): BudgetRecord {
  const cleanCategory = category.trim();
  const query = db.prepare(`
    INSERT INTO budgets (wallet_id, category, amount_limit, month_year)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(wallet_id, category, month_year)
    DO UPDATE SET amount_limit = excluded.amount_limit
  `);
  query.run(walletId, cleanCategory, amountLimit, monthYear);

  const getQuery = db.prepare(`
    SELECT * FROM budgets
    WHERE wallet_id = ? AND category = ? AND month_year = ?
  `);
  return getQuery.get(walletId, cleanCategory, monthYear) as BudgetRecord;
}

export function getBudgetReport(walletId: number, monthYear: string): BudgetReportItem[] {
  const budgetsQuery = db.prepare(`
    SELECT * FROM budgets
    WHERE wallet_id = ? AND month_year = ?
    ORDER BY category ASC
  `);
  const budgets = budgetsQuery.all(walletId, monthYear) as BudgetRecord[];

  return budgets.map((b) => {
    const spentQuery = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS total_spent
      FROM transactions
      WHERE wallet_id = ? AND status = 'confirmed' AND type = 'expense'
        AND (LOWER(category) = LOWER(?) OR LOWER(category) LIKE '%' || LOWER(?) || '%')
        AND COALESCE(occurred_at, substr(created_at, 1, 10)) LIKE ? || '%'
    `);
    const row = spentQuery.get(walletId, b.category, b.category, monthYear) as { total_spent: number };
    return {
      ...b,
      total_spent: Number(row ? row.total_spent : 0),
    };
  });
}

export function checkBudgetWarning(
  walletId: number,
  category: string | null | undefined,
  newExpenseAmount: number,
  monthYear: string
): { isOverbudget: boolean; category?: string; limit?: number; totalAfter?: number } {
  if (!category) return { isOverbudget: false };

  const cleanCategory = category.trim();
  const budgetQuery = db.prepare(`
    SELECT * FROM budgets
    WHERE wallet_id = ? AND month_year = ?
      AND (LOWER(category) = LOWER(?) OR LOWER(?) LIKE '%' || LOWER(category) || '%' OR LOWER(category) LIKE '%' || LOWER(?) || '%')
    ORDER BY CASE WHEN LOWER(category) = LOWER(?) THEN 0 ELSE 1 END
    LIMIT 1
  `);
  const budget = budgetQuery.get(
    walletId,
    monthYear,
    cleanCategory,
    cleanCategory,
    cleanCategory,
    cleanCategory
  ) as BudgetRecord | undefined;

  if (!budget) {
    return { isOverbudget: false };
  }

  const spentQuery = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total_spent
    FROM transactions
    WHERE wallet_id = ? AND status = 'confirmed' AND type = 'expense'
      AND (LOWER(category) = LOWER(?) OR LOWER(category) LIKE '%' || LOWER(?) || '%')
      AND COALESCE(occurred_at, substr(created_at, 1, 10)) LIKE ? || '%'
  `);
  const row = spentQuery.get(walletId, budget.category, budget.category, monthYear) as { total_spent: number };
  const currentSpent = Number(row ? row.total_spent : 0);
  const totalAfter = currentSpent + newExpenseAmount;

  if (totalAfter > budget.amount_limit) {
    return {
      isOverbudget: true,
      category: budget.category,
      limit: budget.amount_limit,
      totalAfter,
    };
  }

  return { isOverbudget: false };
}

export interface RecurringRecord {
  id: number;
  wallet_id: number;
  name: string;
  amount: number;
  category: string | null;
  type: "income" | "expense";
  due_day: number;
  is_active: number;
  last_reminded_date: string | null;
  created_at: string;
}

export interface DueRecurringItem extends RecurringRecord {
  telegram_user_id: string;
  wallet_name: string;
}

export function getUserRecurrings(walletId: number): RecurringRecord[] {
  const query = db.prepare(`
    SELECT * FROM recurrings
    WHERE wallet_id = ? AND is_active = 1
    ORDER BY due_day ASC, id ASC
  `);
  return query.all(walletId) as RecurringRecord[];
}

export function getRecurringById(id: number): RecurringRecord | undefined {
  const query = db.prepare("SELECT * FROM recurrings WHERE id = ?");
  return query.get(id) as RecurringRecord | undefined;
}

export function findActiveRecurringByName(walletId: number, name: string): RecurringRecord | undefined {
  const cleanName = name.trim();
  const query = db.prepare(`
    SELECT * FROM recurrings
    WHERE wallet_id = ? AND is_active = 1
      AND (LOWER(name) = LOWER(?) OR LOWER(name) LIKE '%' || LOWER(?) || '%')
    ORDER BY CASE WHEN LOWER(name) = LOWER(?) THEN 0 ELSE 1 END
    LIMIT 1
  `);
  return query.get(walletId, cleanName, cleanName, cleanName) as RecurringRecord | undefined;
}

export function createRecurring(
  walletId: number,
  name: string,
  amount: number,
  type: "income" | "expense",
  category: string,
  dueDay: number
): RecurringRecord {
  const insert = db.prepare(`
    INSERT INTO recurrings (wallet_id, name, amount, category, type, due_day, is_active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `);
  const info = insert.run(walletId, name.trim(), amount, category.trim(), type, dueDay);
  return getRecurringById(Number(info.lastInsertRowid))!;
}

export function deactivateRecurring(id: number, walletId: number): boolean {
  const update = db.prepare(`
    UPDATE recurrings
    SET is_active = 0
    WHERE id = ? AND wallet_id = ? AND is_active = 1
  `);
  const result = update.run(id, walletId);
  return result.changes > 0;
}

export function getDueRecurrings(dueDay: number, todayStr: string): DueRecurringItem[] {
  const query = db.prepare(`
    SELECT r.*, u.telegram_user_id, w.name as wallet_name
    FROM recurrings r
    JOIN wallets w ON r.wallet_id = w.id
    JOIN users u ON w.user_id = u.id
    WHERE r.is_active = 1
      AND r.due_day = ?
      AND (r.last_reminded_date IS NULL OR r.last_reminded_date != ?)
    ORDER BY r.id ASC
  `);
  return query.all(dueDay, todayStr) as DueRecurringItem[];
}

export function markRecurringReminded(id: number, todayStr: string): void {
  const update = db.prepare("UPDATE recurrings SET last_reminded_date = ? WHERE id = ?");
  update.run(todayStr, id);
}

export function recordTransactionFromRecurring(
  recurring: RecurringRecord,
  occurredAt: string
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
      source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', 'recurring')
  `);
  const note = `Tagihan rutin: ${recurring.name}`;
  const info = insert.run(
    recurring.wallet_id,
    recurring.type,
    recurring.amount,
    recurring.name,
    recurring.category || (recurring.type === "expense" ? "Langganan" : "Pendapatan"),
    note,
    occurredAt
  );
  return Number(info.lastInsertRowid);
}

