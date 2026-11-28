# 17. Customer experience: table QR, online storefront, tracking

The customer-facing pages share one set of components and keep two separate business flows.

| Journey  | Route                   | Credential                                             | Flow                                                                              |
| -------- | ----------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Dine-in  | `/t/<qr token>`         | HttpOnly guest cookie bound to ONE dining session      | scan → menu → dish sheet (qty, request) → cart → send → "Your table" → order more |
| Online   | `/order/<store link>`   | none until ordering; tracking token after              | storefront → pickup/delivery → menu → cart → checkout (server quote) → status     |
| Tracking | `/order/status#<token>` | tracking token in the URL fragment (never sent as URL) | confirmation → live status timeline, payment status separately                    |

## Shared components (`apps/web/src/features/customer`)

- `MenuBrowser`: local search (ja/en names and descriptions; NFKC, katakana folded to hiragana), sticky horizontal
  category tabs that follow the scroll position, every category as a section. No external search service.
- `ItemSheet`: large photo (`srcset` of the 320 px thumbnail and the 1200 px rendition), description, quantity, and a
  per-line request (140 characters, counted by code point like the server). No modifiers are shown: the menu model has none.
- `cart.ts`: lines are `{itemId, quantity, note}`; prices are never stored, every line is resolved against the menu
  the server just returned. Lines merge only when dish **and** request match. Stored per context
  (`rp_qr_cart:<qr token>` in sessionStorage, `rp_online_cart:<store token>` in localStorage, 12 h), validated on
  load, so a cart can never be submitted to another restaurant or table. Removed or sold-out dishes are flagged and
  block submission until the customer removes them.
- `CartPanel` / `CartBar`: phone bottom sheet with a sticky summary bar (safe-area aware); desktop sticky side panel.
- `StatusSteps`: timeline of real states only, labelled in text (no percentages, no invented estimates).
- `CustomerHeader`: restaurant logo/name; `accentStyle` re-tints only the customer page with the restaurant accent.

## Storefront (restaurant-level presentation, `modules/storefront`)

Migration `2026112701_storefront` adds `storefront_profiles` (display name, description, announcement, public phone and
address text, accent color), `storefront_featured_items` (manual, max 8) and `storefront_images` (logo, cover; same
lifecycle, key rules and re-encoding pipeline as menu photos). Staff API: `GET/PUT /storefront`
(`storefront.manage`, optimistic `version`), `PUT/DELETE /storefront/images/:kind`. Public media for active images
only: `/public/media/storefront-images/…`.

- The partner brand stays authoritative: the profile can only add a restaurant name, logo, cover and an accent color.
  The accent must keep 4.5:1 contrast with white (validated server-side). Text is stored and rendered as plain text.
- Featured dishes are a manual choice and labelled "Recommended by the restaurant". No popularity or rating claims.
  Optional future extension (not implemented): "goes well with" pairs configured explicitly by the restaurant.

## Server data added to existing public endpoints

- `GET /public/stores/:token`: `profile`, `featuredItemIds` (only items customers can see).
- `GET /public/tables/:token`: `profile` (name, logo, accent, announcement only).
- `GET /public/session`: `bill` (subtotal, tax breakdown, total) of the guest's own dining session.
- `GET /public/online-orders/current`: restaurant `profile` (name, logo, phone, public address). Still no customer data.

## Reliability rules

- Online checkout re-reads the storefront before showing the form and prices only from the server quote; the order
  carries the reviewed total, which the server compares.
- A submission's idempotency key is kept per request (sessionStorage, keyed by a hash, no personal data stored). After a
  lost response the customer presses the same button again and receives the original order.
- Real-time: the table guest room and the per-order tracking room carry id-only hints; pages refetch over HTTP on
  every hint, on reconnect, and every 15 s while disconnected.
