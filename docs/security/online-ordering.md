# Online ordering: security model

Status: **implemented** in `apps/api/src/modules/online-orders` (with `orders`, `kitchen`, `payments`, `integrations`), tested in
`apps/api/test/integration/online-ordering.test.ts` and `test/websocket/online-realtime.test.ts`. Feature reference:
[../architecture/15-online-ordering.md](../architecture/15-online-ordering.md).

## Trust boundaries

| Actor        | Credential                                                                         | Can                                                                              |
| ------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Anyone       | the public storefront link (`/order/<128-bit token>`, reissuable)                  | read the public menu/hours/fees, get a quote, place an order                     |
| The customer | order-scoped tracking token (256-bit, SHA-256 stored, expires 24 h after the slot) | read ONE order's status (no personal data), cancel it while pending              |
| Staff        | existing staff session (HttpOnly cookie, CSRF + Origin on writes)                  | what their role's permissions allow, if the location's plan includes the feature |

Public routes are mounted **before** the staff guard and live in their own router; nothing public can reach staff APIs.

## Controls

1. **Entitlements on every operation**: storefront, quote, submit (`online_ordering` + `pickup_ordering` / `delivery_management`),
   every staff route, settings save (enabling pickup/delivery needs that key too). Fail closed: no subscription, suspended, or an
   expired override = no access. Frontend visibility is cosmetic.
2. **Server authority**: strict Zod schemas reject unknown fields, so clients cannot send prices, fees, distances, totals or
   coordinates (400). Items, prices, tax, slot validity, delivery eligibility, fee and minimum are decided server-side inside the
   order transaction. The customer's reviewed total is only compared (`409 total_changed`).
3. **Delivery address**: geocoded on the server, outside the DB transaction, with a timeout. Provider failure fails closed (503).
   The provider sits behind a port; no API key or paid provider is assumed.
4. **Idempotent submission**: `Idempotency-Key` required; the record commits with the order. Replays mint a fresh tracking token;
   raw tokens are never stored (not even in the idempotency record).
5. **Anti-spam**: per-IP submit limit (10/10 min), per-phone limit (5/h, keyed by a hash of the normalized number), max 3 pending
   orders per phone and 100 pending per location (`429`), per-IP quote and tracking limits, the shared `/public` read limit.
   Staff can pause ordering instantly and reissue a leaked link.
6. **Tracking credential**: not the order id (an id alone returns 401). Sent in a header (never a cookie, so no CSRF surface) and in
   the status-page URL **fragment**, which is not sent to servers or in Referer. Expiring and revocable; sockets re-validate every 30 s.
7. **Personal data minimization**: name + phone required, email optional, address only for delivery. Stored in a separate,
   RLS-protected table. Lists, events, logs and the customer status page never contain it. Staff read it through a separate endpoint
   with its own permission (`online_orders.contact_view`), and **every read is audited**. Kitchen staff cannot see it.
8. **Tenant isolation**: RLS (`FORCE`) on every new tenant table, plus location filters in every query. Foreign tenants get 404 on
   every route (tested), including payments and contact data.
9. **State integrity**: validated transitions, row locks and `version`; DB checks for `completed ⇒ paid`, rejected/cancelled never keep
   money silently (`voided`/`refund_required`), one completed payment per order (partial unique index). History and audit are
   append-only for the runtime role; online orders, contacts and payments cannot be deleted by it.
10. **Duplicate payments**: row lock, payment-state check, idempotency key and a partial unique index (tested with two concurrent cashiers).
11. **Real-time**: server-assigned rooms only (staff room needs `online_orders.view`; customers join only their order's room),
    Origin check, id-only customer payloads, no personal data in any event.
12. **Audit**: submission (customer), accept, reject (reason + note), cancel (reason, refund flag), dispatch, deliver, complete,
    payment, contact view, settings change (changed keys), pause/resume, link reissue.

## Accepted risks / open items

- Anyone with the public link can place orders (by design); spam is limited, not prevented (no CAPTCHA, no phone verification).
  Staff accept/reject every order, which is the final control.
- A replayed submission (same key AND identical body, i.e. full knowledge of the customer's details) yields another tracking token for
  that order.
- Contact data is not column-encrypted and has no automated retention purge yet (APPI retention policy pending the partner).
- The `static_demo` geocoder must never run in production (the config loader refuses it in staging/production).
