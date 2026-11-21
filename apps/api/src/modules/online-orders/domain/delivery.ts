/**
 * Delivery eligibility and fees. Pure functions.
 *
 * Distance is the STRAIGHT-LINE (great-circle) distance between the store and the server-geocoded customer address,
 * not road distance. Coordinates from the browser are never accepted. Customer-facing copy says so explicitly.
 */
export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface FeeTier {
  maxDistanceM: number;
  feeYen: number;
  minOrderYen: number;
}

const EARTH_RADIUS_M = 6_371_008.8;

export function straightLineMeters(a: LatLng, b: LatLng): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h))));
}

/** The tier that applies at `distanceM` (smallest tier that covers it), or null when outside the delivery area. */
export function tierFor(tiers: readonly FeeTier[], distanceM: number): FeeTier | null {
  const sorted = [...tiers].sort((a, b) => a.maxDistanceM - b.maxDistanceM);
  return sorted.find((t) => distanceM <= t.maxDistanceM) ?? null;
}

export function deliveryRadiusM(tiers: readonly FeeTier[]): number {
  return tiers.reduce((max, t) => Math.max(max, t.maxDistanceM), 0);
}

/** Tiers must be strictly increasing in distance and have unique bounds. */
export function validateTiers(tiers: readonly FeeTier[]): string | null {
  const sorted = [...tiers].sort((a, b) => a.maxDistanceM - b.maxDistanceM);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]?.maxDistanceM === sorted[i - 1]?.maxDistanceM) return "duplicate_tier_distance";
  }
  return null;
}

const SEPARATORS = /[\s\-‐‑‒–—―−ー－()（）]/gu;

/** Japanese phone number -> digits only ("03-1234-5678", "０９０…", "+81 90 …" all accepted). Null if invalid. */
export function normalizePhone(raw: string): string | null {
  let digits = raw.normalize("NFKC").replace(SEPARATORS, "");
  if (digits.startsWith("+81")) digits = `0${digits.slice(3)}`;
  return /^0\d{9,10}$/.test(digits) ? digits : null;
}

/** "150-0002", "〒1500002", "１５０−０００２" -> "1500002". Null if invalid. */
export function normalizePostalCode(raw: string): string | null {
  const digits = raw.normalize("NFKC").replace(/〒/g, "").replace(SEPARATORS, "");
  return /^\d{7}$/.test(digits) ? digits : null;
}

/** Normalizes free text from customers: NFC, control/format characters removed, whitespace collapsed. */
export function cleanText(raw: string | null | undefined, max: number): string | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = raw
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return null;
  return Array.from(cleaned).slice(0, max).join("");
}
