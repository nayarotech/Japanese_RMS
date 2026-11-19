# qr-ordering

**Purpose:** Diners order from their own phone at the table.

**Owns**

- Validation of scanned QR tokens leading to a table session context.
- Anonymous **customer ordering sessions** scoped to exactly one table session (short-lived, rate-limited).
- Customer cart and submission, which calls `orders` to create the order.

**Does not own**

- Orders, menus, tables (uses their public services).

**Security:** A customer session can only read that location's public menu and create or view orders for its own table session. Requires entitlement `qr_ordering` (and `qr_menu` for view-only). Branding is resolved per brand domain.
