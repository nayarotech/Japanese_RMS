/** Formatting helpers. Integers only for money (JPY has no minor unit). */
export function formatYen(amount: number, locale: string): string {
  return new Intl.NumberFormat(locale === "ja" ? "ja-JP" : "en-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatTime(iso: string | Date, locale: string, timeZone = "Asia/Tokyo"): string {
  return new Intl.DateTimeFormat(locale === "ja" ? "ja-JP" : "en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(new Date(iso));
}

export function formatDateTime(
  iso: string | Date,
  locale: string,
  timeZone = "Asia/Tokyo",
): string {
  return new Intl.DateTimeFormat(locale === "ja" ? "ja-JP" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(iso));
}

export function minutesSince(iso: string, now = Date.now()): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
}

export function ratePercent(rateBp: number): string {
  return (rateBp / 100).toString();
}

/** Localized name with Japanese fallback. */
export function pickName(name: { ja: string; en: string | null }, locale: string): string {
  return locale === "en" && name.en ? name.en : name.ja;
}

export function pickSnapshotName(nameJa: string, nameEn: string | null, locale: string): string {
  return locale === "en" && nameEn ? nameEn : nameJa;
}
