# QR ordering model (scan-to-order)

Status: **implemented** in `apps/api/src/modules/qr-ordering` and `modules/tables`, with tests in
`apps/api/test/security/security.test.ts` and `test/integration/dine-in-flow.test.ts`.

## Product decision (2026-11-20, ADR-0008)

Guests **scan the table's QR and order**. No code, no account, no proof of presence. Per the product owner, the risk of
someone ordering from outside the restaurant (for example from a photographed QR) is **accepted** and not mitigated.

## Rules that still apply (they cost the guest nothing)

1. **Orders always belong to the scanned table.** Each table has a unique QR token. If the table is free, the first scan opens a dining
   session automatically (no staff step). While the bill is requested, new orders are paused.
2. **Orders attach to the table's current session only.** Scanning issues a random 256-bit guest token in an `HttpOnly`,
   `SameSite=Lax` cookie (`__Host-` prefixed in production). Only its SHA-256 hash is stored, and it is bound to exactly that session.
   The server never accepts a table or session id from the client.
3. **Credentials end with the meal.** At checkout or close, all guest tokens of that session are revoked. A phone from an earlier party
   cannot order onto the next party's bill (tested). Tokens also expire after 4 hours.
4. **Staff controls.** Staff can **sign out all guest phones** of a table (`POST /sessions/:id/guests/revoke`) and **reissue a table's QR**
   (the old printed code stops working). They can also pause ordering with _Request bill_ or disable QR ordering for the location.
5. **Server authority.** Clients send only menu item ids, quantities and notes. Prices, tax and availability come from the server, and unknown
   fields are rejected.
6. **Abuse limits.** Per-IP rate limits on scans/joins and per-guest limits on orders (Redis). Orders require an `Idempotency-Key`, so double taps
   do not duplicate.
7. **CSRF.** Guest mutations require a guest CSRF token (HMAC of the guest session id) and an allowed `Origin`.
8. **Entitlement.** `table_qr_ordering` is checked on every join and order.
9. **Privacy.** Public responses contain no staff, financial-report or other-table data. Socket messages to guests are id-only refresh hints
   for their own session.

## Accepted risks (documented on purpose)

- Anyone with the QR (in person or via a photo) can order onto that table's bill until checkout. Staff mitigations: _Sign out guest
  phones_, _Request bill_ (pauses ordering), voiding unwanted items, or reissuing the QR.
- There is no CAPTCHA or device fingerprinting. Rate limits are the only automated abuse control.
- Optional stronger modes remain possible later without changing the order model (credentials are already session-bound): a per-session code,
  staff approval of new devices, or "staff confirms QR orders before the kitchen".
