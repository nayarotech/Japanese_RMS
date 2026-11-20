# apps/api/src/modules/

One directory per **business capability** (bounded context) of the modular monolith.
Full rules and the dependency diagram: [docs/architecture/02-module-boundaries.md](../../../../docs/architecture/02-module-boundaries.md).

## Standard internal layout (created only when the module is implemented)

```
modules/<name>/
  index.ts            # PUBLIC API of the module: application services, types, events. The ONLY import target for other modules.
  http/               # Express router, controllers, Zod request/response schemas.
  application/        # Use cases. Owns the transaction, runs authorization + entitlement checks, calls domain, writes outbox events.
  domain/             # Pure business rules, invariants, state machines, value objects. No Express/pg/Redis/Kysely imports (lint-enforced).
  infrastructure/     # Kysely queries, external adapters. Private to the module.
  jobs/               # Background job handlers this module owns (run by apps/worker).
  *.test.ts           # Unit tests colocated with the code they test.
```

Not every module needs every layer. A simple CRUD-like module may have only `http/`, `application/`
and `infrastructure/`. Add `domain/` when there are real invariants worth isolating.

## Rules

1. Other modules import only from `modules/<name>/index.ts`. Never from another module's `infrastructure/`, `domain/` internals, or tables.
2. A module reads and writes **only its own tables**. Cross-module data comes from the owning module's application service, or a read model it publishes.
3. No circular dependencies between modules. If two modules need each other, extract the shared concept or communicate through domain events (outbox).
4. Every use case that touches tenant data runs inside a tenant-scoped transaction (`docs/architecture/03-tenant-isolation.md`).
5. Authorization (who may act) and entitlements (what the subscription includes) are both checked in the application layer. See `docs/architecture/04-subscription-entitlements.md`.

## Module index

| Module           | One-line responsibility                                                            |
| ---------------- | ---------------------------------------------------------------------------------- |
| `identity`       | Who you are: credentials, sessions, MFA, account recovery, device sessions.        |
| `authorization`  | What you may do: roles, permissions, policy checks, the request `AccessContext`.   |
| `tenants`        | Restaurant organizations, their lifecycle and memberships.                         |
| `restaurants`    | Branches/locations and their operational configuration.                            |
| `staff`          | Staff profiles and their role assignments per tenant/location.                     |
| `menus`          | Categories, products, options, prices, availability.                               |
| `tables`         | Floor layout, tables, table sessions (seating lifecycle).                          |
| `orders`         | POS orders, items, price snapshots, authoritative totals.                          |
| `kitchen`        | Kitchen tickets, item-level prep/serve status, food-ready notifications.           |
| `payments`       | Restaurant checkout, payment records, refunds (NOT SaaS subscription billing).     |
| `qr-ordering`    | Customer self-ordering at the table via QR.                                        |
| `online-orders`  | Online ordering with pickup and delivery fulfilment.                               |
| `reporting`      | Sales summaries, business-day reports, exports.                                    |
| `subscriptions`  | Plans, plan versions, restaurant subscriptions, lifecycle, partner sync.           |
| `entitlements`   | Feature registry and effective feature/limit resolution. `requireFeature()`.       |
| `branding`       | White-label brand configuration and public brand resolution.                       |
| `platform-admin` | Partner-operator workflows: onboarding, support access, high-impact confirmations. |
| `audit`          | Append-only audit trail of security-relevant and privileged actions.               |
| `notifications`  | Outbound email/messaging, localized and branded templates.                         |
| `integrations`   | Adapters for third-party services (e.g. HotPepper, Google reviews) behind ports.   |

> Note: the original proposal named a `billing` module. It was renamed **`payments`** to avoid confusion
> with SaaS subscription billing, which lives in `subscriptions`. See ADR-0003.
