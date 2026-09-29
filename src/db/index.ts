import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const dataDir = path.join(rootDir, "data");
const uploadsDir = path.join(rootDir, "uploads");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const db = new Database(path.join(dataDir, "bot.db"));
db.pragma("journal_mode = WAL");

// Auto-migrate: if transactions table exists from older version without file_hash, add it first
const columns = db.pragma("table_info(transactions)") as Array<{ name: string }>;
if (columns.length > 0 && !columns.some((col) => col.name === "file_hash")) {
  db.exec("ALTER TABLE transactions ADD COLUMN file_hash TEXT;");
}

// Auto-migrate: ensure 'deleted' status is supported in transactions CHECK constraint
const tableInfo = db
  .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transactions'")
  .get() as { sql: string } | undefined;
if (tableInfo && !tableInfo.sql.includes("'deleted'")) {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE transactions_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('income', 'expense')),
      amount INTEGER NOT NULL,
      merchant TEXT,
      category TEXT,
      note TEXT,
      occurred_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'confirmed', 'cancelled', 'deleted')),
      source TEXT,
      file_hash TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(wallet_id) REFERENCES wallets(id)
    );
    INSERT INTO transactions_new (id, wallet_id, type, amount, merchant, category, note, occurred_at, status, source, file_hash, created_at)
    SELECT id, wallet_id, type, amount, merchant, category, note, occurred_at, status, source, file_hash, created_at FROM transactions;
    DROP TABLE transactions;
    ALTER TABLE transactions_new RENAME TO transactions;
    CREATE INDEX IF NOT EXISTS idx_transactions_wallet_status ON transactions(wallet_id, status);
    CREATE INDEX IF NOT EXISTS idx_transactions_file_hash ON transactions(file_hash);
    PRAGMA foreign_keys = ON;
  `);
}

// Initialize tables & indices from schema.sql
const candidates = [
  path.join(__dirname, "schema.sql"),
  path.join(rootDir, "src", "db", "schema.sql"),
];
const schemaPath = candidates.find((p) => fs.existsSync(p));
if (schemaPath) {
  const schema = fs.readFileSync(schemaPath, "utf-8");
  db.exec(schema);
}

export default db;