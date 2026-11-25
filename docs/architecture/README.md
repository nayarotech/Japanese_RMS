# Architecture documentation

Status: **Phase 0: proposed, awaiting approval.** These documents describe the intended design. Unless a
section explicitly says "created", nothing described here is implemented, tested or validated yet.

| #   | Document                                                                     | Covers                                                                |
| --- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| A   | [01-high-level.md](01-high-level.md)                                         | Components, how they communicate, request and event flows             |
| B   | [02-module-boundaries.md](02-module-boundaries.md)                           | Modules, layers, dependency rules, cross-module communication         |
| C   | [03-tenant-isolation.md](03-tenant-isolation.md)                             | Tenancy model, access context, RLS, composite constraints             |
| D   | [04-subscription-entitlements.md](04-subscription-entitlements.md)           | Plans, versions, features, limits, overrides, enforcement             |
| E   | [05-white-label-branding.md](05-white-label-branding.md)                     | Brand model, resolution by domain, leak prevention                    |
| F   | [06-realtime-websockets.md](06-realtime-websockets.md)                       | Socket.IO rooms, Redis adapter, outbox-driven events, reconciliation  |
| G   | [07-database-principles.md](07-database-principles.md)                       | Transactions, indexing, money, pooling, roles, performance            |
| H   | [../security/security-architecture.md](../security/security-architecture.md) | AuthN, AuthZ, trust boundaries, privileged operations, controls       |
| I   | [08-horizontal-scaling.md](08-horizontal-scaling.md)                         | Statelessness, replicas, pools, shutdown, capacity path 100 to 2,000+ |
| J   | [09-deployment-strategy.md](09-deployment-strategy.md)                       | Environments, release flow, migrations, rollback                      |
| K   | [10-implementation-roadmap.md](10-implementation-roadmap.md)                 | Recommended build order after Phase 0, open decisions                 |
| -   | [11-localization.md](11-localization.md)                                     | Japanese/English, JPY, time zone, business day, tax caveats           |
| -   | [12-testing-strategy.md](12-testing-strategy.md)                             | Test types, tools, the cross-tenant test policy                       |
| -   | [13-tech-stack.md](13-tech-stack.md)                                         | Chosen versions and the reasons for each choice                       |
| -   | [14-dine-in-workflow.md](14-dine-in-workflow.md)                             | Implemented: dine-in workflow (Basic package)                         |
| -   | [15-online-ordering.md](15-online-ordering.md)                               | Implemented: online ordering, pickup and delivery (Standard package)  |
| -   | [16-menu-item-images.md](16-menu-item-images.md)                             | Implemented: menu item photos (upload, storage, delivery, cleanup)    |

Decisions with lasting consequences are recorded as ADRs in [../decisions/](../decisions/README.md).

## Glossary

| Term            | Meaning                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Platform        | The whole SaaS installation, operated by the Japanese partner (commercial) and the dev team (technical).                |
| Partner / Brand | The white-label brand under which restaurants use the product (for example a brand such as insyokuten.jp, if approved). |
| Tenant          | A restaurant **organization** (company or owner). Unit of data isolation.                                               |
| Location        | A **branch** of a tenant. Unit of operations (tables, POS devices, orders, business day).                               |
| Membership      | A user's link to a tenant (tenant role) and optionally to specific locations.                                           |
| Feature         | An implemented capability with a stable key (for example `qr_ordering`).                                                |
| Entitlement     | The effective availability of a feature or limit for a location at a point in time.                                     |
| Permission      | What a specific user is allowed to do (RBAC). Independent of entitlement.                                               |
| Outbox          | Table where business events are written in the same transaction as the change, then relayed.                            |
