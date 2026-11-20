# 0007. Bring a basic kitchen workflow into the initial release

- **Status:** Accepted
- **Date:** 2026-11-20
- **Supersedes:** the exclusion of kitchen workflows in the Phase 0 brief and 02-module-boundaries.md

## Context

Phase 0 excluded kitchen order receiving and kitchen displays. The approved Phase 1 brief (Basic dine-in package) requires
kitchen tickets, preparation status, item-level readiness and waiter notifications.

## Decision

Add a `kitchen` module limited to the basic prep and serve workflow: tickets per order submission, item statuses
(`queued/preparing/ready/served/voided`), derived ticket status, and food-ready/served events. Stations, routing, inventory,
recipes and costing remain out of scope. The module owns `kitchen_tickets` and `kitchen_ticket_items`. `orders` creates tickets
and voids items through the kitchen module's public functions inside the same transaction.

## Consequences

- One kitchen implementation, shared by every plan with `kitchen_workflow`.
- Station-based routing can be added later by creating several tickets per order without changing the order model.
