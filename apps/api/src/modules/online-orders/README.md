# online-orders

**Purpose:** Online ordering with **pickup** and **delivery** fulfilment (Standard package and above).
Reference: [docs/architecture/15-online-ordering.md](../../../../../docs/architecture/15-online-ordering.md),
security: [docs/security/online-ordering.md](../../../../../docs/security/online-ordering.md), ADR-0009.

**Owns**

- Storefront link, ordering settings, weekly ordering hours, pickup slots, delivery fee tiers (distance-based).
- `online_orders` (acceptance/fulfilment status, payment status, money + delivery-fee snapshot), status history.
- Customer contact data (`online_order_contacts`) and order-scoped tracking tokens.
- The kitchen hook that turns kitchen progress into `preparing` / `ready`.

**Does not own (reuses)**

- Orders, lines, prices, tax and totals (`orders`, `menus`). Kitchen tickets (`kitchen`). Cash records (`payments`).
  Geocoding (`integrations` port). Outbox, audit, idempotency, entitlements.

**Layout:** `domain/` (state machine, hours/slots, distance/tiers, input normalization: pure), `application/` (settings,
storefront, manage, tracking, records, pricing), `http/` (public routes before the staff guard, staff routes after it).

**Rules:** entitlements `online_ordering` + `pickup_ordering` / `delivery_management` on every operation; permission per staff
action; contact data only via the audited contact endpoint; lock order kitchen items → online order.
