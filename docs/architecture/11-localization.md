# Japanese market and localization

> Localization is not compliance. Japanese tax, invoice (適格請求書), payment, consumer-protection and
> privacy (APPI) requirements must be **verified against approved specifications** before implementation.
> Nothing in this repository claims compliance.

## Languages

- Japanese (`ja`) is the default. English (`en`) is supported. The locale is resolved from user preference, then brand default, then `Accept-Language`.
- **UI strings:** message catalogs in `apps/web/src/i18n/messages/{ja,en}.json`, keyed by feature. No hard-coded text in components.
  Library proposal: `next-intl` (App Router and Server Components support), confirmed in Phase 1.
- **Business content** (menu names and descriptions, category names, location names) is stored per locale in the DB by
  the owning module, with Japanese required and English optional. Fallback to Japanese.
- **Server-generated text** (emails, receipts, PDF reports, error messages shown to users) uses server-side catalogs
  in the owning module (`notifications`, `payments` receipts), with the same keys approach. API errors return stable
  `code`s that the web app translates. Raw server messages are never shown.
- Translation workflow: JSON catalogs in Git, reviewed by a Japanese speaker. A missing-key check runs in CI (Phase 1).

## Formatting

| Item           | Rule                                                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Currency       | JPY, integer, `Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY' })` → `￥1,200`.                                                     |
| Time zone      | Store UTC (`timestamptz`). Display in the **location's** time zone (default `Asia/Tokyo`).                                                          |
| Dates          | `ja-JP` formats (`2026年11月19日`, `11/19(木)`). Japanese era (令和) display only where the spec requires it.                                       |
| Names          | Support full-width characters, furigana fields where needed (staff and customer names). No first/last-name order assumptions.                       |
| Phone / postal | Japanese formats validated leniently (`〒` 7-digit postal codes). Address fields follow the Japanese order (prefecture → city → street → building). |
| Text           | Full-width/half-width normalization (NFKC) for search and dedupe, never for stored display values.                                                  |

## Business day

Restaurants often operate past midnight. Each location defines a **business-day cutoff** (for example 04:00).
Every order and payment stores `business_date` computed at creation from the location's time zone and cutoff,
and reports group by `business_date`, not by calendar date. Changing the cutoff affects only future records.

## Tax (to be specified)

Design accommodates: multiple consumption-tax rates with effective dates (for example standard and reduced for
take-out food), tax-inclusive (内税) or tax-exclusive (外税) price display per location, per-item tax category, a
configurable rounding mode, and per-rate totals on receipts. Dine-in vs. take-out may change the applicable rate
for the same item. The order channel and an explicit eat-in/take-out flag are stored on the order. Exact rules come from the approved spec.

## Receipts

Japanese layout (store name, address, phone, date/time, items, per-rate subtotals and tax, total, payment method,
change, receipt number, optional registration number). Printer integration (ESC/POS over network/Bluetooth/USB
via a local bridge or browser printing) is an open hardware decision.
