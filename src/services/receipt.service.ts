import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseReceiptImage } from "./ai.service.js";
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
