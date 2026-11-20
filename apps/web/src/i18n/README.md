# src/i18n/

- `request.ts`: next-intl configuration (no locale in URLs). Locale comes from the `rp_locale` cookie, then the browser, then Japanese.
- `messages/en.json`: **source** catalog.
- `messages/ja.json`: Japanese catalog. **Status: DRAFT, NOT APPROVED.** All Japanese strings were drafted by the development team
  and must be reviewed and approved by the Japanese partner before release. Track review in `translation-status.json`.
- Business content (menu item names and so on) is stored per locale in the database, not here.

Rules: no hard-coded UI text in components. Keys are grouped by feature. `scripts/check-i18n.mjs` (run by `pnpm --filter web check:i18n`)
fails if the two catalogs have different keys.
