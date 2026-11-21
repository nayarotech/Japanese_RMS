# Architecture Decision Records

One file per significant decision: `NNNN-short-title.md`, copied from [0000-template.md](0000-template.md).
ADRs are immutable once **Accepted**. To change a decision, write a new ADR that supersedes the old one.

| ADR                                                      | Title                                                                           | Status   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------- | -------- |
| [0001](0001-modular-monolith.md)                         | Modular monolith with Express, Next.js, PostgreSQL, Redis                       | Proposed |
| [0002](0002-shared-schema-multitenancy-rls.md)           | Shared-schema multi-tenancy with PostgreSQL RLS                                 | Proposed |
| [0003](0003-entitlements-separate-from-authorization.md) | Feature entitlements as data over a code registry; `billing` renamed `payments` | Proposed |
| [0004](0004-outbox-and-postgres-jobs.md)                 | Transactional outbox and PostgreSQL-backed jobs                                 | Proposed |
| [0005](0005-worker-imports-api-job-handlers.md)          | Worker reuses API module code via an explicit export                            | Proposed |
| [0006](0006-authentication-library.md)                   | Authentication library selection                                                | Open     |
| [0007](0007-kitchen-module-in-scope.md)                  | Bring a basic kitchen workflow into the initial release                         | Accepted |
| [0008](0008-qr-join-code.md)                             | QR ordering: scan-to-order (no join code, no staff step)                        | Accepted |
| [0009](0009-online-orders-reuse-order-domain.md)         | Online orders reuse the order domain; online rules live in `online-orders`      | Accepted |

All Phase 0 ADRs are **Proposed** until the architecture is approved.
