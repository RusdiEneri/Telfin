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

// Initialize tables from schema.sql
const candidates = [
  path.join(__dirname, "schema.sql"),
  path.join(rootDir, "src", "db", "schema.sql"),
];
const schemaPath = candidates.find((p) => fs.existsSync(p));
if (schemaPath) {
  const schema = fs.readFileSync(schemaPath, "utf-8");
  db.exec(schema);
}

// Auto-migrate: ensure file_hash column exists
const columns = db.pragma("table_info(transactions)") as Array<{ name: string }>;
if (columns.length > 0 && !columns.some((col) => col.name === "file_hash")) {
  db.exec("ALTER TABLE transactions ADD COLUMN file_hash TEXT;");
  db.exec("CREATE INDEX IF NOT EXISTS idx_transactions_file_hash ON transactions(file_hash);");
}

export default db;