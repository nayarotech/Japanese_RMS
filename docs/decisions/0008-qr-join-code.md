# 0008. QR ordering: scan-to-order (no join code, no staff step)

- **Status:** Accepted (product owner decision, 2026-11-20)
- **Related:** docs/security/qr-ordering.md

## Context

Printed table QR codes are static and can be photographed. An initial implementation required a 4-digit per-session join code
given by staff. The product owner decided that remote or off-premises ordering is not a concern and that guests should simply
scan and order.

## Decision

Each table has its own unique QR. Scanning it issues a guest credential bound to **that table's** current dining session; if the
table is free, the first scan opens a session automatically (the table shows as occupied). No code, no staff step. Credentials are revoked at checkout, close or staff action, and expire after 4 hours. The join code,
its lockout and its rotation endpoint were removed from the schema, API and UI.

## Consequences

- Lowest friction for guests. No staff step beyond seating.
- **Accepted risk:** anyone holding the QR can order onto a seated table's bill until checkout. Staff can sign out guest phones,
  pause ordering (request bill), void items, or reissue the QR.
- A stronger mode (code or device approval) can be reintroduced later as a location setting. Guest credentials are already
  session-bound, so the order model would not change.
