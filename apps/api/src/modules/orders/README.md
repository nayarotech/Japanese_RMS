# orders

**Purpose:** The POS order and its authoritative totals.

**Owns**

- Orders, order items, item options, **price and tax snapshots** at order time.
- Order state machine (draft, placed, served, voided, closed) and modification rules.
- Server-side total calculation (integer arithmetic, explicit rounding rules once the tax spec is approved).
- Idempotency keys for order creation and modification (duplicate submit protection).
- Optimistic concurrency (`version` column) for concurrent edits from multiple devices.

**Does not own**

- Payment capture or refunds (`payments`). Menu definitions (`menus`). Seating (`tables`).

**Invariants**

- Never trust client-sent prices or totals. Only product IDs, quantities and options are accepted.
- Order write and its outbox event are committed in the **same transaction**.
- Sources: POS, QR (`qr-ordering`) and online (`online-orders`) all create orders through this module's application service.
