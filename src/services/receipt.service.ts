import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import db from "../db/index.js";
import { parseReceiptImage } from "./ai.service.js";
import { logger } from "../utils/logger.js";
import type { ReceiptExtraction } from "../validations/receipt.schema.js";

const uploadsDir = path.join(process.cwd(), "uploads");

export function saveUploadedBuffer(buffer: Buffer, extension = ".jpg"): string {
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  const randomSuffix = crypto.randomBytes(4).toString("hex");
  const filename = `receipt_${Date.now()}_${randomSuffix}${extension}`;
  const targetPath = path.join(uploadsDir, filename);

  fs.writeFileSync(targetPath, buffer);
  return targetPath;
}

export async function processReceiptFile(filePath: string): Promise<ReceiptExtraction> {
  return parseReceiptImage(filePath);
}

/**
 * Remove temporary files in uploads/ that are not part of any confirmed transaction.
 */
export function cleanupPendingUploads(): number {
  if (!fs.existsSync(uploadsDir)) return 0;

  const confirmedRows = db
    .prepare("SELECT source FROM transactions WHERE status = 'confirmed' AND source IS NOT NULL")
    .all() as Array<{ source: string }>;
  const confirmedSet = new Set(confirmedRows.map((r) => path.resolve(r.source)));

  let removedCount = 0;
  const files = fs.readdirSync(uploadsDir);
  for (const file of files) {
    if (file === ".gitkeep") continue;
    const fullPath = path.resolve(uploadsDir, file);
    if (!confirmedSet.has(fullPath)) {
      try {
        fs.unlinkSync(fullPath);
        removedCount++;
      } catch (err) {
        logger.error(`Gagal menghapus file temporary ${fullPath}:`, err);
      }
    }
  }

  return removedCount;
}
