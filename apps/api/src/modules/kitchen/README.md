# kitchen

**Purpose:** The basic preparation and serving workflow for dine-in orders (added in the Phase 1 dine-in scope, ADR-0007).

**Owns**

- Kitchen tickets (one per order submission) and kitchen ticket items (one per order line, with name, quantity and note snapshots).
- Item-level status: `queued → preparing → ready → served` (`voided` set by orders). Ticket status is derived from items.
- Food-ready notifications (`waiter.food.ready`) and serving confirmation (`waiter.food.served`).

**Does not own**

- Orders, prices or bills (`orders`). Stations, inventory, recipes and food costing are explicitly out of scope.

**Rules:** kitchen staff (`kitchen.update`) start and ready items; floor staff (`floor.serve`) serve them. Invalid transitions return 409.
Every action re-checks the `kitchen_workflow` entitlement.
