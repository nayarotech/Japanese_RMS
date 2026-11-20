# Dine-in workflow (Basic package): implementation reference

Status: **implemented and tested** (see "Verification"). Shared by every plan that includes the dine-in
feature keys. There is no plan-specific code.

## Flow

```
staff seats guests ──► dining session (open) ──► guest scans table QR ──► guest credential (bound to this session)
                                      │
   STAFF_POS order ──┐                ▼
   TABLE_QR order ───┴─► orders + order_items (price/tax snapshots) ─► kitchen ticket + items (queued)
                                                                          │ start ─► preparing ─► ready (per item)
                                                                          ▼
                                                            waiter.food.ready ─► serve ─► served
   more orders (same session) ... ─► combined bill ─► cash checkout (lock, verify, pay, receipt) ─► session closed, table free
```

## Data model (migrations `2026112001_foundation`, `2026112002_dine_in`)

| Table                                                                       | Owner module           | Key constraints                                                                                         |
| --------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `restaurant_tables`                                                         | tables                 | `UNIQUE(location_id, name)`, composite FK to location                                                   |
| `table_qr_tokens`                                                           | tables                 | one active token per table (partial unique)                                                             |
| `table_sessions`                                                            | tables                 | **one non-closed session per table** (partial unique), `status` check, `closed_at` consistency check    |
| `guest_sessions`                                                            | qr-ordering            | token hash unique, bound to one table session                                                           |
| `menu_categories`, `menu_items`, `*_translations`                           | menus                  | integer `price_yen`, tax rate FK, ja/en translations                                                    |
| `orders`                                                                    | orders                 | per-location `order_no`, source check (`STAFF_POS` needs a user, `TABLE_QR` needs a guest session)      |
| `order_items`                                                               | orders                 | one row per submitted line (never merged), `note ≤ 140`, price/tax snapshot, generated `line_total_yen` |
| `kitchen_tickets`, `kitchen_ticket_items`                                   | kitchen                | item-level status, ticket status derived                                                                |
| `payments`                                                                  | payments               | **one completed settlement per session** (partial unique), `received ≥ due`, `change = received − due`  |
| `receipts`                                                                  | payments               | immutable JSON snapshot, per-location `receipt_no`                                                      |
| `outbox_events`, `audit_events`, `idempotency_records`, `location_counters` | infrastructure / audit | see 07-database-principles                                                                              |

Every tenant-owned table has `FORCE ROW LEVEL SECURITY`. Financial and audit rows cannot be updated or deleted by the
runtime role.

## State machines

- **Dining session**: `open` → `bill_requested` (ordering paused) → `open` (reopen) → `closed` (checkout or close-empty).
- **Kitchen item**: `queued` → `preparing` → `ready` → `served`, or `voided` (by orders). Kitchen staff do the first two
  steps and floor staff do serving. Invalid transitions return `409 invalid_kitchen_transition`.
- **Kitchen ticket**: derived from its items (`new`, `preparing`, `ready`, `served`, `voided`). Partial readiness never marks the
  ticket ready.

## Concurrency and money

| Situation                            | Mechanism                                                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Duplicate submit (double tap, retry) | `Idempotency-Key` stored in the same transaction. Replays return the stored response; same key with a different body returns 409.                            |
| Additional order vs. checkout        | Both lock the session row (`FOR UPDATE`). Checkout sends `expectedTotalYen`, and a changed bill returns `409 bill_changed`. A closed session rejects orders. |
| Two cashiers settling at once        | Session lock + one-settlement partial unique index. Exactly one succeeds.                                                                                    |
| Concurrent edits                     | `version` on order items and tables (optimistic concurrency).                                                                                                |
| Failure mid-checkout                 | Single transaction: payment, receipt, session close, guest revocation, outbox and audit commit together or not at all.                                       |
| Totals                               | Server-only integer arithmetic (BigInt for intermediates). Tax **per rate per bill** with location rounding mode. **Pending partner/accountant approval.**   |

## Permissions (role → permission, enforced server-side)

| Permission                       | owner | manager | cashier | waiter | kitchen |
| -------------------------------- | ----- | ------- | ------- | ------ | ------- |
| tables.view / sessions.manage    | ✓     | ✓       | ✓       | ✓      |         |
| tables.manage / menu.manage      | ✓     | ✓       |         |        |         |
| menu.view                        | ✓     | ✓       | ✓       | ✓      | ✓       |
| orders.create / orders.edit      | ✓     | ✓       | ✓       | ✓      |         |
| orders.void_prepared             | ✓     | ✓       |         |        |         |
| kitchen.view / kitchen.update    | ✓     | ✓       |         |        | ✓       |
| floor.view                       | ✓     | ✓       | ✓       | ✓      |         |
| floor.serve                      | ✓     | ✓       |         | ✓      |         |
| checkout.perform / receipts.view | ✓     | ✓       | ✓       |        |         |

Customers have no staff permissions. They act only through the guest credential (see `docs/security/qr-ordering.md`).

## Entitlements (feature keys)

`table_management`, `dine_in_pos`, `table_qr_ordering`, `kitchen_workflow`, `cash_checkout`. The Basic and Standard fixture
plans both include all five. Suspended, cancelled or expired subscriptions return `403 feature_not_entitled` (placeholder policy).

## HTTP API (`/api/v1`)

| Method & path                                                                                                         | Who                           | Notes                                                |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------- |
| `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`                                                               | staff                         | session cookie + CSRF token                          |
| `GET /floor/tables`                                                                                                   | tables.view                   | table map with derived occupancy and totals          |
| `GET/POST /tables`, `PATCH /tables/:id`                                                                               | tables.manage                 | create, edit, activate/deactivate (version)          |
| `GET /tables/:id/qr`, `POST /tables/:id/qr/rotate`                                                                    | tables.manage                 | printable token, reissue                             |
| `POST /tables/:id/sessions`                                                                                           | sessions.manage               | seat guests                                          |
| `GET /sessions/:id`                                                                                                   | tables.view                   | session, orders, combined bill                       |
| `POST /sessions/:id/request-bill`, `/reopen`, `/guests/revoke`, `/close`                                              | sessions.manage               |                                                      |
| `POST /sessions/:id/orders`                                                                                           | orders.create                 | **Idempotency-Key** required                         |
| `PATCH /order-items/:id`, `POST /order-items/:id/void`                                                                | orders.edit (+ void_prepared) |                                                      |
| `GET /sessions/:id/bill`                                                                                              | tables.view                   |                                                      |
| `GET /kitchen/tickets`, `POST /kitchen/items/:id/{start,ready}`, `POST /kitchen/tickets/:id/{start,ready}`            | kitchen.*                     |                                                      |
| `GET /floor/ready-items`, `POST /floor/items/:id/serve`, `POST /floor/tickets/:id/serve`                              | floor.*                       | reconciliation endpoint                              |
| `POST /sessions/:id/checkout/cash`                                                                                    | checkout.perform              | **Idempotency-Key**, `expectedTotalYen`              |
| `GET /receipts/:id`                                                                                                   | receipts.view                 |                                                      |
| `GET /menu`, `PATCH /menu/items/:id/availability`, `POST /menu/items`, `PUT /menu/items/:id`, `POST /menu/categories` | menu.*                        |                                                      |
| `GET /public/brand`                                                                                                   | public                        | white-label brand by host                            |
| `GET /public/tables/:token`                                                                                           | public                        | menu + session state (no secrets)                    |
| `POST /public/tables/:token/join`                                                                                     | public                        | scan-to-order: seated table → guest cookie (no code) |
| `GET /public/session`, `POST /public/session/orders`                                                                  | guest                         | order history, place order (**Idempotency-Key**)     |

## Real-time events (outbox → worker → Socket.IO Redis emitter)

| Event                                         | Rooms                                          |
| --------------------------------------------- | ---------------------------------------------- |
| `table.session.opened` / `updated` / `closed` | staff, floor (+ guest hint for updated/closed) |
| `order.created`                               | staff, floor, guest hint                       |
| `order.updated`                               | staff, floor, kitchen, guest hint              |
| `kitchen.ticket.created`                      | kitchen                                        |
| `kitchen.item.status_changed`                 | kitchen, staff, floor, guest hint              |
| `waiter.food.ready`                           | assigned waiter's user room, else floor room   |
| `waiter.food.served`                          | floor, kitchen, staff                          |
| `checkout.completed`                          | staff, floor, guest hint                       |

Clients refetch on every event and on every (re)connect, with a 15-second fallback poll while disconnected. Clients send no
business events over the socket.

## Verification (actual results at time of writing)

- 93 automated API tests passing (unit + PostgreSQL/Redis integration, security, concurrency, multi-instance WebSocket).
- A manual browser run on local Docker covered the full flow: seat → QR scan → two ramen with different notes → kitchen partial
  ready → live waiter alert → serve → additional QR order → combined bill → cash checkout → receipt → table free.
