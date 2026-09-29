/**
 * Format integer rupiah to display string (e.g. 52500 -> "Rp 52.500")
 */
export function formatRupiah(amount: number): string {
  const formatted = new Intl.NumberFormat("id-ID", {
    maximumFractionDigits: 0,
  }).format(Math.round(amount));

  return `Rp${formatted}`;
}

/**
 * Clean & parse any raw string or number into an integer rupiah value.
 */
export function parseRupiah(input: string | number): number {
  if (typeof input === "number") {
    return Math.round(input);
  }
  // Remove non-digit characters
  const clean = input.replace(/[^0-9]/g, "");
  const parsed = parseInt(clean, 10);
  return isNaN(parsed) ? 0 : parsed;
}
