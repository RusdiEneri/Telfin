const JAKARTA_FORMATTER = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZoneName: "short",
});

export function parseDateToJakarta(dateInput?: string | Date | null): Date {
  if (!dateInput) return new Date();
  if (dateInput instanceof Date) return dateInput;

  const str = String(dateInput).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return new Date(`${str}T00:00:00+07:00`);
  }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(str)) {
    return new Date(str.replace(" ", "T") + "Z");
  }
  return new Date(str);
}

/**
 * Formats a Date or date string to Indonesian locale with 24-hour time in Asia/Jakarta timezone.
 * Example output: "Selasa, 29 September 2026 pukul 20.27 WIB"
 */
export function formatDateTimeJakarta(dateInput?: string | Date | null): string {
  if (!dateInput) return JAKARTA_FORMATTER.format(new Date());
  const date = parseDateToJakarta(dateInput);
  if (isNaN(date.getTime())) {
    return String(dateInput);
  }
  return JAKARTA_FORMATTER.format(date);
}

/**
 * Returns current year and month in 'YYYY-MM' format in Asia/Jakarta timezone.
 * Example output: "2026-09"
 */
export function getCurrentYearMonthJakarta(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
  }).format(date);
}

/**
 * Returns today's date in 'YYYY-MM-DD' format in Asia/Jakarta timezone.
 */
export function getTodayDateJakarta(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * Returns current day of month (1-31) in Asia/Jakarta timezone.
 */
export function getTodayDayJakarta(date: Date = new Date()): number {
  const dayStr = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jakarta",
    day: "numeric",
  }).format(date);
  return parseInt(dayStr, 10);
}
