import fs from "node:fs";
import path from "node:path";

const timestamp = () => new Date().toISOString();
const errorLogPath = path.join(process.cwd(), "data", "error.log");

function writeErrorToFile(formattedMsg: string): void {
  if (process.env.NODE_ENV === "production") {
    try {
      const dataDir = path.dirname(errorLogPath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      fs.appendFileSync(errorLogPath, `${formattedMsg}\n`);
    } catch (err) {
      console.error("Gagal menulis ke error.log:", err);
    }
  }
}

export const logger = {
  info: (msg: string, ...args: unknown[]) => console.log(`[${timestamp()}] [INFO] ${msg}`, ...args),
  warn: (msg: string, ...args: unknown[]) => console.warn(`[${timestamp()}] [WARN] ${msg}`, ...args),
  error: (msg: string, ...args: unknown[]) => {
    const serializedArgs = args
      .map((a) => (a instanceof Error ? a.stack || a.message : typeof a === "object" ? JSON.stringify(a) : String(a)))
      .join(" ");
    const formatted = `[${timestamp()}] [ERROR] ${msg}${serializedArgs ? ` ${serializedArgs}` : ""}`;
    console.error(formatted);
    writeErrorToFile(formatted);
  },
  debug: (msg: string, ...args: unknown[]) => {
    if (process.env.DEBUG === "true") {
      console.debug(`[${timestamp()}] [DEBUG] ${msg}`, ...args);
    }
  },
};
