/**
 * Local menu search (no external service): matches the Japanese and English names and descriptions. Input and text are
 * normalized the same way: NFKC (full-width -> half-width), lower case, and katakana folded to hiragana, so
 * "ラーメン", "らーめん" and "ramen" (when the English name says so) all find the dish.
 */
import type { CustomerCategory, CustomerMenuItem } from "./types";

export function normalizeForSearch(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/\s+/g, " ")
    .trim();
}

function haystack(i: CustomerMenuItem): string {
  return normalizeForSearch(
    [i.name.ja, i.name.en, i.description.ja, i.description.en].filter(Boolean).join(" "),
  );
}

export function searchMenu(menu: readonly CustomerCategory[], query: string): CustomerMenuItem[] {
  const terms = normalizeForSearch(query).split(" ").filter(Boolean);
  if (terms.length === 0) return [];
  const out: CustomerMenuItem[] = [];
  for (const c of menu)
    for (const i of c.items) {
      const h = haystack(i);
      if (terms.every((t) => h.includes(t))) out.push(i);
    }
  return out;
}
