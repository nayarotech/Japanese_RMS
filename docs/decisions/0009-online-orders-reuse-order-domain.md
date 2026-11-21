# 0009. Online orders reuse the order domain; online-specific rules live in `online-orders`

- **Status:** Accepted (Phase 2, Standard package)
- **Date:** 2026-11-20
- **Related:** docs/architecture/15-online-ordering.md, docs/security/online-ordering.md

## Context

The Standard package adds pickup and delivery orders placed from outside the restaurant. The brief requires one ordering engine for
STAFF_POS, TABLE_QR, ONLINE_PICKUP and ONLINE_DELIVERY, the existing kitchen workflow, and separate acceptance, preparation,
fulfilment and payment states. Online orders have no table or dining session.

## Decision

1. **Same order tables.** `orders`/`order_items` accept online sources with a NULL table session (enforced per source by a CHECK).
   One insert path prices every channel; online orders use the menu item's **takeout tax rate** (Japanese reduced rate for food).
2. **A 1:1 fulfilment record** `online_orders` (module `online-orders`) holds what is different: status, payment status, the money and
   delivery-fee snapshot, scheduled time. Customer personal data is in its own table.
3. **Kitchen on acceptance.** Pending orders are not sent to the kitchen. Accepting creates a normal kitchen ticket (order number + due
   time instead of a table).
4. **Kitchen progress drives the online status through an injected hook** (`kitchenRoutes(deps, { afterOnlineTicketChange })`, wired in
   `app.ts`). Kitchen never imports online-orders (no module cycle); online-orders imports kitchen only through its public API.
   Lock order is always kitchen items → online order.
5. **Payments** settle a session **or** one order (`payments.order_id`), keeping one immutable table and one duplicate-payment guard.
6. **Geocoding behind a port** in `integrations`, with `disabled` (default, fail closed) and `static_demo` (dev/test) adapters. The
   real provider is a business decision (terms, accuracy for Japanese addresses, price).
7. **Entitlement overrides** are resolved now (read side) so a Basic location can be granted online ordering explicitly by a platform
   operator; the runtime role cannot write them.

## Consequences

- No second ordering engine; reports and future features see every order in one place.
- Dine-in code paths are unchanged in behaviour (95 pre-existing tests pass unmodified); table-only operations (line edit/void) refuse
  online lines explicitly.
- Delivery is unavailable in any environment until a geocoding provider is chosen and integrated.
- Tax treatment (8% takeout food, 10% delivery fee) needs accountant confirmation; it is data (per-item rate), not code.
