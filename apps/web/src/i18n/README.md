# src/i18n/

- `messages/ja.json` (default locale) and `messages/en.json`: UI message catalogs, keyed by feature (`"menus.title"`).
- Library choice (proposed: `next-intl`) is confirmed in Phase 1.
- Business data (menu item names and so on) is **not** translated here. It is stored per-locale in the database by the owning module.
- Currency and date formatting use `Intl` with `ja-JP`, `JPY` and `Asia/Tokyo` defaults, overridable by location settings.

The catalogs start empty on purpose. Keys are added with the features that use them.
