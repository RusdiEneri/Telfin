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
