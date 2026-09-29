/**
 * Format integer rupiah to display string (e.g. 52500 -> "Rp52.500")
 */
export function formatRupiah(amount: number): string {
  const formatted = new Intl.NumberFormat("id-ID", {
    maximumFractionDigits: 0,
  }).format(Math.round(amount));

  return `Rp${formatted}`;
}

/**
 * Parse input string/number into an integer rupiah.
 * Returns a positive integer, or 0 if invalid.
 */
export function parseRupToInt(input: string | number): number {
  if (typeof input === "number") {
    return Number.isFinite(input) && input > 0 ? Math.round(input) : 0;
  }
  if (!input || typeof input !== "string") {
    return 0;
  }

  const trimmed = input.trim();
  if (trimmed.includes("-")) {
    return 0;
  }

  // Strip currency prefix and strip trailing ,00 or .00 cents if present
  const cleaned = trimmed.replace(/^rp\.?\s*/i, "").split(/[,.]00$/)[0];
  const digits = cleaned.replace(/[^0-9]/g, "");
  if (!digits) return 0;

  const parsed = parseInt(digits, 10);
  return isNaN(parsed) || parsed <= 0 ? 0 : parsed;
}

export const parseRupiah = parseRupToInt;

/**
 * Generate a 10-block emoji bar chart based on spending percentage.
 * Color mapping:
 *   > 30%: 🟥 (Merah - Boros)
 *   15-30%: 🟧 (Oranye)
 *   5-15%: 🟨 (Kuning)
 *   <= 5%: 🟩 (Hijau)
 *   Remainder: ⬜ (Kosong)
 */
export function generateBarChart(percentage: number): string {
  if (percentage <= 0) return "⬜".repeat(10);
  let filled = Math.min(10, Math.max(0, Math.round(percentage / 10)));
  if (percentage > 0 && filled === 0) filled = 1;

  let emoji = "🟩";
  if (percentage > 30) emoji = "🟥";
  else if (percentage >= 15) emoji = "🟧";
  else if (percentage > 5) emoji = "🟨";
  else emoji = "🟩";

  return emoji.repeat(filled) + "⬜".repeat(10 - filled);
}

/**
 * Returns an appropriate emoji icon based on category name.
 */
export function getCategoryEmoji(category: string): string {
  const cat = category.toLowerCase();
  if (cat.includes("makan") || cat.includes("restoran") || cat.includes("food") || cat.includes("kuliner")) return "🍔";
  if (cat.includes("kopi") || cat.includes("coffee") || cat.includes("cafe") || cat.includes("kafe")) return "☕";
  if (cat.includes("transport") || cat.includes("bensin") || cat.includes("ojek") || cat.includes("ride") || cat.includes("motor")) return "🛵";
  if (cat.includes("belanja") || cat.includes("shopping") || cat.includes("mall") || cat.includes("supermarket")) return "🛍️";
  if (cat.includes("tagihan") || cat.includes("bill") || cat.includes("listrik") || cat.includes("air") || cat.includes("pulsa") || cat.includes("internet")) return "🧾";
  if (cat.includes("hiburan") || cat.includes("entertainment") || cat.includes("game") || cat.includes("bioskop") || cat.includes("nonton")) return "🎮";
  if (cat.includes("kesehatan") || cat.includes("obat") || cat.includes("medis") || cat.includes("dokter")) return "💊";
  if (cat.includes("pendidikan") || cat.includes("edukasi") || cat.includes("buku")) return "📚";
  if (cat.includes("gaji") || cat.includes("salary")) return "💵";
  return "📂";
}

