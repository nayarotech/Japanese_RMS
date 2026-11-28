# 18. Floor: waiter service operations

Floor moves prepared food from the kitchen to the table. It is deliberately separate from **Tables** (occupancy,
dining sessions, POS, bill, checkout) and **Kitchen** (preparation). All three read the SAME records:
`table_sessions`, `orders`/`order_items`, `kitchen_tickets`/`kitchen_ticket_items`. Floor has no data of its own
except the pickup acknowledgement below.

## Workflow

```
order (QR / POS / accepted online order) -> kitchen ticket, already `preparing` -> kitchen: ready (per item)
  -> Floor: [pick up]  (optional acknowledgement; item stays `ready`)
  -> Floor: served     (ready -> served, per item or a chosen set of items across the table's tickets)
  -> table stays occupied until the existing checkout/close closes the session
```

- The kitchen starts on receipt: tickets and items are created in `preparing` (no "new" column, no "start" press;
  migration `2026112901` moved open legacy rows). Consequence: floor staff can no longer edit or void a sent dish;
  a manager voids it with a reason (`orders.void_prepared`), and an accepted online order goes straight to `preparing`
  (cancelling it then needs a manager). The Kitchen page shows two separate screens, **Preparing** and
  **Ready to serve**, switched by tabs (`/kitchen#preparing`, `/kitchen#ready`).
- Item states are unchanged: `queued -> preparing -> ready -> served` (+ `voided`). Ticket status is derived, so
  partial readiness never marks a whole order ready, and serving some items never changes the others.
- **Pickup is an annotation, not a state** (`kitchen_ticket_items.picked_up_at/by`, migration
  `2026112801_floor_pickup`). It tells other waiters "someone is carrying this". Kitchen, guest status and
  online hand-over are unaffected. Repeating your own pickup is a no-op; another waiter's pickup is `409 already_picked_up`.
  Serving does not require a pickup first.
- Food of a closed (settled) session is not a task: it disappears from the board and serving it is
  `409 session_closed`.

## API (all branch-scoped by the staff session; RLS + `location_id`)

| Endpoint                                                                                 | Permission    | Notes                                                                                               |
| ---------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------- |
| `GET /floor/board`                                                                       | `floor.view`  | ready items, items in preparation, active tables (counts are portions). No money, no customer data. |
| `POST /floor/items/pickup` `{kitchenItemIds}`                                            | `floor.serve` | 1-50 ids, all must be `ready`                                                                       |
| `POST /floor/items/serve` `{kitchenItemIds}`                                             | `floor.serve` | all-or-nothing across tickets; a stale or duplicate request is `409` and changes nothing            |
| `POST /floor/items/:id/serve`, `POST /floor/tickets/:id/serve`, `GET /floor/ready-items` | as before     | kept for compatibility                                                                              |

Concurrency: items are locked `FOR UPDATE` in id order (the same order as every kitchen action), then the transition
is validated, so two waiters can never both serve or both pick up the same food. Entitlement: `kitchen_workflow`
(part of every dine-in plan).

## Real time

Events go through the transactional outbox and the Socket.IO Redis adapter (multi-instance):
`kitchen.item.status_changed`, `waiter.food.ready` (assigned waiter, else all floor staff), `waiter.food.served`,
`waiter.food.picked_up` (new; floor, kitchen and staff rooms of that branch, never guests). Clients treat events as hints and
refetch `GET /floor/board` (coalesced); reconnects reconcile; a 15 s poll runs only while the socket is down.
PostgreSQL is the source of truth; Redis only fans out.

## UI

Ready to serve (primary, task cards grouped by table, every button targets real item ids, "still in the kitchen" shown
on the card) -> Preparing (secondary) -> Active tables (tertiary, link to the table's order). One merged in-app alert
per table; vibration only when the waiter turns it on (no permission prompts).
