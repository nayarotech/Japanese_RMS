/**
 * Per-item special instructions ("less spicy", "no onion"). Stored as plain text, rendered escaped.
 * Normalization removes control/format characters (including bidi overrides) and collapses whitespace.
 */
export const MAX_NOTE_LENGTH = 140;

// Control (Cc) and format (Cf) characters: newlines, NULs, zero-width and bidi-override characters.
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu;

export function normalizeNote(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = raw.normalize("NFC").replace(CONTROL_OR_FORMAT, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return null;
  // Array.from iterates by code point, so multi-byte characters are never split.
  return Array.from(cleaned).slice(0, MAX_NOTE_LENGTH).join("");
}
