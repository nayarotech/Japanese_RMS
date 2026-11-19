# tables

**Purpose:** Physical seating and the lifecycle of a seated party.

**Owns**

- Floor areas, tables, capacity, QR code identity per table (rotatable tokens).
- **Table sessions:** open, seated, ordering, bill requested, closed. One active session per table (DB-enforced with a partial unique index).

**Does not own**

- Orders (`orders` references a table session). Payments (`payments`).

**Notes:** Table status changes emit outbox events for real-time floor views.
