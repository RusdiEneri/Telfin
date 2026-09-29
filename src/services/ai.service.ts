import fs from "node:fs";
import path from "node:path";
import { ReceiptExtractionSchema, type ReceiptExtraction } from "../validations/receipt.schema.js";
import { logger } from "../utils/logger.js";

const RECEIPT_PROMPT = `Anda adalah asisten cerdas pembaca nota/struk belanja dan bukti transfer transaksi dalam mata uang Rupiah (IDR).
Tugas Anda adalah membaca gambar nota secara akurat dan mengekstrak data transaksi ke dalam format JSON berikut:
{
  "type": "expense",
  "amount": 52500,
  "merchant": "Nama Toko / Tempat",
  "category": "Makanan & Minuman",
  "note": "Ringkasan barang yang dibeli",
  "occurred_at": "YYYY-MM-DD"
}

Aturan penting:
1. "amount" WAJIB berupa angka bulat (integer) rupiah tanpa simbol atau titik/koma (contoh: Rp52.500 -> 52500). Gunakan Grand Total akhir yang dibayar pelanggan.
2. "type": "expense" untuk pengeluaran/belanja, atau "income" untuk bukti penerimaan uang/gaji/penjualan.
3. "category": Pilih kategori paling sesuai: Makanan & Minuman, Belanja, Transportasi, Tagihan, Kesehatan, Hiburan, Pendidikan, atau Lain-lain.
4. "occurred_at": Tanggal transaksi jika tertera (format YYYY-MM-DD atau YYYY-MM-DD HH:mm), atau null jika tidak jelas.
5. Balas HANYA dengan format JSON yang valid.`;

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".jpg":
    case ".jpeg":
    default:
      return "image/jpeg";
  }
}

function cleanJsonString(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.replace(/^```json\s*/, "").replace(/```\s*$/, "");
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```\s*/, "").replace(/```\s*$/, "");
  }
  return cleaned.trim();
}

async function extractWithGemini(filePath: string, mimeType: string, base64Data: string): Promise<ReceiptExtraction> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY belum dikonfigurasi di file .env");
  }

  // ponytail: defaults to gemini-3.5-flash; auto-fallbacks on 503/429 high demand spikes
  const primaryModel = process.env.GEMINI_MODEL || "gemini-3.5-flash";
  const candidateModels = Array.from(new Set([primaryModel, "gemini-3.5-flash", "gemini-3-flash-preview"]));

  let lastError: Error | null = null;

  for (const model of candidateModels) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                inline_data: {
                  mime_type: mimeType,
                  data: base64Data,
                },
              },
              {
                text: RECEIPT_PROMPT,
              },
            ],
          },
        ],
        generationConfig: {
          response_mime_type: "application/json",
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.warn(`Gemini API (${model}) returned ${response.status}: ${errorText}`);
      lastError = new Error(`Gagal memproses gambar dengan Gemini (${response.status})`);
      if (response.status === 503 || response.status === 429 || response.status >= 500) {
        continue;
      }
      throw lastError;
    }

    const result: any = await response.json();
    const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error("Gemini tidak mengembalikan hasil teks dari nota.");
    }

    const parsedJson = JSON.parse(cleanJsonString(text));
    return ReceiptExtractionSchema.parse(parsedJson);
  }

  throw lastError || new Error("Gagal memproses gambar dengan semua model Gemini yang tersedia.");
}

async function extractWithOpenAI(filePath: string, mimeType: string, base64Data: string): Promise<ReceiptExtraction> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY belum dikonfigurasi di file .env");
  }

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const url = "https://api.openai.com/v1/chat/completions";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: RECEIPT_PROMPT },
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${base64Data}`,
              },
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(`OpenAI API error (${response.status}): ${errorText}`);
    throw new Error(`Gagal memproses gambar dengan OpenAI (${response.status})`);
  }

  const result: any = await response.json();
  const text = result?.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error("OpenAI tidak mengembalikan hasil teks dari nota.");
  }

  const parsedJson = JSON.parse(cleanJsonString(text));
  return ReceiptExtractionSchema.parse(parsedJson);
}

export async function parseReceiptImage(filePath: string): Promise<ReceiptExtraction> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File foto tidak ditemukan: ${filePath}`);
  }

  const mimeType = getMimeType(filePath);
  const fileBuffer = fs.readFileSync(filePath);
  const base64Data = fileBuffer.toString("base64");

  const provider = (process.env.AI_PROVIDER || "gemini").toLowerCase();
  logger.info(`Menganalisis nota menggunakan provider AI: ${provider} (file: ${filePath})`);

  if (provider === "openai") {
    return extractWithOpenAI(filePath, mimeType, base64Data);
  }

  return extractWithGemini(filePath, mimeType, base64Data);
}

async function generateInsightWithGemini(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY belum dikonfigurasi di file .env");
  }

  const primaryModel = process.env.GEMINI_MODEL || "gemini-3.5-flash";
  const candidateModels = Array.from(new Set([primaryModel, "gemini-3.5-flash", "gemini-3-flash-preview"]));

  let lastError: Error | null = null;

  for (const model of candidateModels) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.warn(`Gemini API (${model}) returned ${response.status}: ${errorText}`);
      lastError = new Error(`Gagal menghasilkan analisa dengan Gemini (${response.status})`);
      if (response.status === 503 || response.status === 429 || response.status >= 500) {
        continue;
      }
      throw lastError;
    }

    const result: any = await response.json();
    const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error("Gemini tidak mengembalikan teks analisa.");
    }

    return text.trim();
  }

  throw lastError || new Error("Gagal menghasilkan analisa dengan semua model Gemini yang tersedia.");
}

async function generateInsightWithOpenAI(prompt: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY belum dikonfigurasi di file .env");
  }

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const url = "https://api.openai.com/v1/chat/completions";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(`OpenAI API error (${response.status}): ${errorText}`);
    throw new Error(`Gagal menghasilkan analisa dengan OpenAI (${response.status})`);
  }

  const result: any = await response.json();
  const text = result?.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error("OpenAI tidak mengembalikan teks analisa.");
  }

  return text.trim();
}

export async function generateFinancialInsight(recapSummary: string): Promise<string> {
  const prompt = `Kamu adalah asisten keuangan pribadi yang ramah, objektif, dan tidak menghakimi. Berikut adalah rekap keuangan user bulan ini:
${recapSummary}

Berikan 2 kalimat singkat berupa pujian jika user hemat/berhasil under-budget, atau teguran/saran praktis yang actionable jika user boros di kategori tertentu. Gunakan bahasa Indonesia yang santai dan gunakan 1-2 emoji.`;

  const provider = (process.env.AI_PROVIDER || "gemini").toLowerCase();
  logger.info(`Meminta analisa insight keuangan bulanan menggunakan provider AI: ${provider}`);

  if (provider === "openai") {
    return generateInsightWithOpenAI(prompt);
  }

  return generateInsightWithGemini(prompt);
}

