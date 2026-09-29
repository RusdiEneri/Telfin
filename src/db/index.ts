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

export default db;