// Fails if message catalogs have different key sets (missing or extra translations).
import { readFileSync } from "node:fs";

const load = (l) =>
  JSON.parse(readFileSync(new URL(`../src/i18n/messages/${l}.json`, import.meta.url), "utf8"));
const keys = (obj, prefix = "") =>
  Object.entries(obj).flatMap(([k, v]) =>
    typeof v === "object" && v !== null ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );

const en = new Set(keys(load("en")));
const ja = new Set(keys(load("ja")));
const missingJa = [...en].filter((k) => !ja.has(k));
const extraJa = [...ja].filter((k) => !en.has(k));
if (missingJa.length || extraJa.length) {
  console.error("i18n catalogs differ", { missingJa, extraJa });
  process.exit(1);
}
console.log(`i18n OK: ${en.size} keys (ja: draft, pending partner review)`);
