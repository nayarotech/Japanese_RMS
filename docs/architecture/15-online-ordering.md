# Online ordering, pickup and delivery (Standard package): implementation reference

Status: **implemented and tested** (see "Verification"). One implementation, used by every plan that includes the
feature keys. There is no plan-specific code. Decision record: [ADR-0009](../decisions/0009-online-orders-reuse-order-domain.md).

## Flow

```
customer opens /order/<storeToken> ─► menu, cart, per-item notes ─► pickup (slot) or delivery (address)
   │  POST …/quote (server price + server-geocoded delivery fee)        POST …/orders (Idempotency-Key)
   ▼
orders + order_items (source ONLINE_PICKUP | ONLINE_DELIVERY, no table session, takeout tax snapshot)
online_orders (pending_acceptance, money + fee snapshot) + online_order_contacts (PII) + tracking token (hash only)
   │  online.order.created ─► Online screen (staff)
   ▼
staff Accept ─► kitchen ticket (EXISTING kitchen workflow, due at the pickup / estimated delivery time)
staff Reject (reason) ─► order voided, customer sees "declined"
   │  kitchen Start ─► online status `preparing`   kitchen Ready (whole ticket) ─► `ready`   (injected hook)
   ▼
pickup:   ready ─► complete (cash recorded in the same step if unpaid; DB enforces completed ⇒ paid)
delivery: ready ─► dispatch ─► out_for_delivery ─► deliver ─► delivered (payment stays UNPAID until cash is recorded)
```

## Reuse of the existing order system

| Concern                    | Reused as-is / extended                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Menu, prices, availability | `menus.getOrderableItems(…, "takeout")`: same items and prices; tax from the item's **takeout** rate (falls back to the dine-in rate).    |
| Orders and lines           | Same `orders`/`order_items` tables and the same insert path as POS/QR (`insertOrder`). Lines with different notes stay separate.          |
| Totals                     | Same `computeBill` (integer yen, tax per rate per order, location rounding). The delivery fee is added as a line at the standard rate.    |
| Idempotency                | Same `withIdempotency` (record written in the order transaction).                                                                         |
| Kitchen                    | Same tickets/items/actions. Tickets without a table show the order number and a due time. Online tickets are handed over, never "served". |
| Payments                   | Same `payments` table (now: a session **or** one order), same immutability, partial unique index = one completed payment per order.       |
| Outbox, relay, Socket.IO   | Same outbox/worker/Redis emitter. New events and two new rooms.                                                                           |
| Audit, RLS, entitlements   | Same audit trail, tenant RLS on every new tenant table, same `requireFeature`.                                                            |

Only what differs is new (module `online-orders`): storefront link, ordering settings/hours, delivery fee tiers, the fulfilment
record, customer contact data, status history and tracking tokens.

## Data model (migration `2026112003_online_ordering`)

| Table                          | Owner         | Key constraints                                                                                                                                  |
| ------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `orders` (changed)             | orders        | `table_session_id` nullable; `orders_source_actor_check`: dine-in sources need a session and an actor, online sources have **no** session/actor. |
| `order_items` (changed)        | orders        | `table_session_id` nullable                                                                                                                      |
| `kitchen_tickets` (changed)    | kitchen       | `order_no` (backfilled), `due_at`; `kitchen_tickets_table_check`: dine-in has table session + name, online has neither                           |
| `payments` (changed)           | payments      | `order_id`; exactly one of session/order (`payments_subject_check`); `payments_one_settlement_per_order_uq`                                      |
| `menu_items` (changed)         | menus         | `takeout_tax_rate_id` (nullable, same-tenant FK)                                                                                                 |
| `entitlement_overrides`        | subscriptions | grant/revoke per location, reason + operator + window. **Read-only** for the runtime role.                                                       |
| `online_ordering_settings`     | online-orders | one row per location; bounded minutes/amounts; store lat/lng both-or-neither; `version`                                                          |
| `online_ordering_hours`        | online-orders | weekday windows, `closes_at > opens_at` (24:00 allowed), unique start per weekday; overlaps rejected by the app                                  |
| `delivery_fee_tiers`           | online-orders | `max_distance_m` unique per location; the largest is the radius                                                                                  |
| `online_store_links`           | online-orders | platform lookup table (no RLS, like `table_qr_tokens`); one active link per location                                                             |
| `online_orders`                | online-orders | 1:1 with an order; type ⇔ payment method; `completed ⇒ paid`; rejected/cancelled ⇒ `voided`/`refund_required`; reason ⇔ status checks            |
| `online_order_contacts`        | online-orders | name, normalized JP phone, optional email, delivery address + server geocode. Separate table for access control and future purge. No DELETE.     |
| `online_order_status_history`  | online-orders | append-only (no UPDATE/DELETE for the runtime role)                                                                                              |
| `online_order_tracking_tokens` | online-orders | SHA-256 of the token only; expiry; revocation; platform lookup table                                                                             |

## State model (separate concepts, never one field)

| Concept                 | Where                                       | Values                                                                                                      |
| ----------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Acceptance + fulfilment | `online_orders.status`                      | `pending_acceptance → accepted → preparing → ready → completed` (pickup) / `→ out_for_delivery → delivered` |
| Kitchen preparation     | `kitchen_tickets` / `kitchen_ticket_items`  | existing kitchen states; synced into `preparing` / `ready` by the kitchen hook                              |
| Payment settlement      | `online_orders.payment_status` + `payments` | `unpaid → paid`; on reject/cancel `voided` or (if money was taken) `refund_required`                        |

Terminal: `completed`, `delivered`, `rejected`, `cancelled`. Mapping to the brief's names: `PENDING_ACCEPTANCE` … `DELIVERED`
are the same states in lower case (the codebase convention). Rules (`domain/status.ts`, mirrored by DB checks):

- Accept / reject / customer-cancel only from `pending_acceptance`. Reject needs a reason code (`other` needs a note).
- Staff cancel from `accepted` (order managers) or `preparing`/`ready`/`out_for_delivery` (`online_orders.cancel`, managers). Reason required.
- Pickup completion requires payment (collected in the same request if needed). Delivery may be `delivered` **unpaid**; cash is
  recorded separately and the order stays on the active list until it is.
- Invalid transitions return `409 invalid_online_order_transition`; nothing is written.

## Ordering hours, pickup slots, delivery area

- Orders are accepted only while **open now** (inside a weekly window, location time zone), not paused, and enabled. No hours = closed.
- Pickup slots: from each window's opening, every `pickup_slot_minutes`, strictly before closing, not earlier than now + prep time,
  today plus `pickup_days_ahead` days. The server regenerates slots at submission; the requested time must be one of them.
- Delivery: the **server** geocodes the address (`integrations` `Geocoder` port), computes the **straight-line** distance to the
  store, picks the smallest covering tier (fee + zone minimum), and stores the distance and fee snapshot on the order. Browser
  coordinates are rejected (strict schema). A changed address is re-quoted and re-checked at submission (the address is part of the
  idempotent request).
- Geocoding failure behaviour (fail closed): provider down or slow → `503 geocoding_unavailable` (customer may retry or choose pickup);
  unknown address → `422 address_not_found`; only city/prefecture precision → `422 address_not_precise`; outside the radius →
  `422 outside_delivery_area`; no provider configured → delivery is shown as unavailable, `409 delivery_unavailable`.
- Minimum order: max(store minimum, delivery zone minimum) on the **item** subtotal.
- Staff settings show the delivery area on a **Leaflet** map (store pin + one circle per tier). Clicking the map or dragging the
  pin sets the store location; the latitude/longitude inputs remain the keyboard path. The map is staff-only and never used for
  customer addresses. Tiles: `NEXT_PUBLIC_MAP_TILE_URL` / `NEXT_PUBLIC_MAP_ATTRIBUTION` (default: OpenStreetMap's public tile
  server, which is fine for light staff use; set a commercial or self-hosted provider before heavy traffic).

## Money and tax (PENDING accountant approval)

- Tax rates are per location (`tax_rates`, basis points). Besides the seeded 8%/10%, a manager can type a percentage on a menu
  item (`POST /menu/tax-rates { rateBp }`): an existing rate with that value is reused, otherwise a `custom_<bp>` rate is created
  (audited). Rates are never edited in place; order lines snapshot `tax_rate_bp`, so a rate change only affects new orders.
- Takeout/delivery food uses the item's takeout rate (fixtures: food and soft drinks 8%, alcohol 10%); the delivery fee is taxed at the
  location's `standard` rate (else its highest rate). Tax is computed per rate per order with the location rounding mode.
- The customer sends the total they reviewed (`expectedTotalYen`); it is compared, never used. A mismatch returns `409 total_changed`.

## Concurrency

| Situation                            | Mechanism                                                                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Double submit / retry                | `Idempotency-Key` (scope per location). Replays return the same order; each response gets a fresh tracking token (none stored in clear). |
| Two staff press Accept               | Row lock (`FOR UPDATE`) + transition check + `version`. One 200, one 409; exactly one kitchen ticket (`UNIQUE(order_id)`).               |
| Kitchen action vs. cancel / handover | Same lock order everywhere: kitchen ticket items, then the online order row (no deadlock between the two paths).                         |
| Two payments for one order           | Row lock + `payment_status` check + partial unique index on `payments(order_id)`.                                                        |
| Failure mid-submission               | One transaction: order, lines, online order, contact, history, outbox, audit, idempotency record commit together or not at all (tested). |

## Permissions (role → permission)

| Permission                   | owner | manager | cashier | waiter | kitchen |
| ---------------------------- | ----- | ------- | ------- | ------ | ------- |
| online_orders.view           | ✓     | ✓       | ✓       | ✓      |         |
| online_orders.manage         | ✓     | ✓       | ✓       |        |         |
| online_orders.fulfill        | ✓     | ✓       | ✓       | ✓      |         |
| online_orders.cancel         | ✓     | ✓       |         |        |         |
| online_orders.contact_view   | ✓     | ✓       | ✓       | ✓      |         |
| online_settings.manage       | ✓     | ✓       |         |        |         |
| checkout.perform (take cash) | ✓     | ✓       | ✓       |        |         |

Customers act only through the storefront link (public data) and their order-scoped tracking token.

## Entitlements

`online_ordering` (storefront, settings, management), `pickup_ordering` (pickup orders, pickup completion), `delivery_management`
(delivery orders, dispatch/deliver). Fixture plans: **Basic** = dine-in only; **Standard** and **Premium** = dine-in + the three online
keys. Enabling pickup/delivery in settings also requires the matching key, so operational settings can never grant a feature.
Platform-granted **overrides** (`entitlement_overrides`) are resolved as (plan ∪ grants) − revokes, ∩ code registry. Only platform
operators can write them (there is no admin UI yet; see "Unfinished dependencies").

## HTTP API (`/api/v1`)

| Method & path                                          | Who                                  | Notes                                                             |
| ------------------------------------------------------ | ------------------------------------ | ----------------------------------------------------------------- |
| `GET /public/stores/:storeToken`                       | public                               | state (open/paused/closed/unavailable), hours, slots, tiers, menu |
| `POST /public/stores/:storeToken/quote`                | public (rate limited)                | server totals, fee, distance, minimum                             |
| `POST /public/stores/:storeToken/orders`               | public (rate limited per IP + phone) | **Idempotency-Key**, returns `trackingToken` once                 |
| `GET /public/online-orders/current`                    | `X-Order-Token`                      | status view, no personal data                                     |
| `POST /public/online-orders/current/cancel`            | `X-Order-Token`                      | only while pending                                                |
| `GET/PUT /online/settings`                             | online_settings.manage               | settings + hours + tiers + link, atomic save with `version`       |
| `POST /online/link/rotate`                             | online_settings.manage               | old link stops working                                            |
| `POST /online/pause`, `/online/resume`                 | online_orders.manage                 | operational pause                                                 |
| `GET /online-orders?scope=active\|recent`              | online_orders.view                   | summaries (no personal data)                                      |
| `GET /online-orders/:id`                               | online_orders.view                   | lines, notes, money, history, payment                             |
| `GET /online-orders/:id/contact`                       | online_orders.contact_view           | personal data, **audited**                                        |
| `POST /online-orders/:id/accept` / `reject` / `cancel` | online_orders.manage (+ .cancel)     | reason codes                                                      |
| `POST /online-orders/:id/dispatch` / `deliver`         | online_orders.fulfill + delivery key |                                                                   |
| `POST /online-orders/:id/complete`                     | online_orders.fulfill + pickup key   | **Idempotency-Key**; cash in the same step needs checkout.perform |
| `POST /online-orders/:id/payments/cash`                | checkout.perform                     | **Idempotency-Key**, `expectedTotalYen`                           |

Menu: `POST/PUT /menu/items` accept `takeoutTaxRateId` (nullable).

## Real-time events (outbox → worker → Socket.IO Redis emitter)

| Event                                                                                                                      | Rooms                                                                       |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `online.order.created`                                                                                                     | `t:{tenant}:l:{location}:online` (staff with online_orders.view)            |
| `online.order.accepted / rejected / cancelled / preparing / ready / dispatched / delivered / completed / payment_recorded` | online staff room + `t:{tenant}:oo:{onlineOrderId}:customer` (id-only hint) |
| `kitchen.ticket.created`, `kitchen.item.status_changed` (existing)                                                         | kitchen (online tickets never reach table-guest rooms)                      |

Payloads carry ids, order number, type and status only, never personal data. Customer sockets authenticate with the tracking token in
the handshake `auth` (no cookie) and are re-validated every 30 s (expiry/revocation ends them). Every client refetches on events and on
every (re)connect.

## Verification (actual results at time of writing)

- `pnpm test`: **150 tests passing** (95 pre-existing dine-in tests unchanged + 55 new), against real PostgreSQL 18 (RLS) and Redis 8,
  including two API instances for WebSocket delivery. New files: `src/modules/online-orders/domain/*.test.ts`,
  `test/integration/online-ordering.test.ts`, `test/websocket/online-realtime.test.ts`, relay routing cases.
- `pnpm lint`, `pnpm typecheck`, `pnpm format:check`, `check:i18n` (438 keys) and `next build` pass.
- Not done: a manual browser walkthrough of the new screens (only build/type/lint verified for the UI).

## Known limitations

- **No geocoding provider** is integrated. `GEOCODER_PROVIDER=disabled` (default) refuses delivery; `static_demo` (dev/test only,
  refused in staging/production) knows five demo postal codes. Straight-line distance only, no road distance.
- Pay on pickup / cash on delivery only (recorded as cash). No online payment, so "pay online first" mode stops ordering.
- Refunds are flagged (`refund_required`) but not recorded in the system. No receipts are issued for online orders yet.
- No contact-data retention/purge job yet (APPI retention period to be confirmed by the partner). PII is not column-encrypted.
- Delivery orders may be placed until closing time (no "last order = close − prep" rule). Overnight windows must be split at 24:00.
- No customer notifications outside the status page (no email/SMS/LINE). No courier assignment or driver tracking (out of scope).
- Japanese strings are drafts pending partner review (`translation-status.json`).
