# 0002. Shared database and schema multi-tenancy, enforced with PostgreSQL Row-Level Security

- **Status:** Proposed
- **Date:** 2026-11-19
- **Related:** docs/architecture/03-tenant-isolation.md, 07-database-principles.md

## Context

Thousands of small tenants, each with several branches. Strong isolation is mandatory. Operational cost of
per-tenant databases or schemas (migrations × N, connection counts) is prohibitive at this scale.

## Options considered

1. Database per tenant: strongest isolation, unmanageable at 2,000+ tenants for a small team.
2. Schema per tenant: migration fan-out, catalog bloat, connection-pool complexity.
3. **Shared schema with `tenant_id` + RLS + app-level authorization + composite FKs.**

## Decision

Option 3. The runtime role has no `BYPASSRLS` and does not own tables. Tenant context is set per transaction with
`set_config('app.tenant_id', …, true)`. Policies fail closed when the context is absent. A separate migrator role owns the schema.

## Consequences

- Positive: one schema, cheap onboarding, isolation enforced by the database even when application code has bugs.
- Negative: every tenant-scoped query must run inside a transaction helper. RLS adds planning overhead (mitigated by `tenant_id`-leading indexes). Platform-wide operations need explicit, audited paths.
- Follow-up: merge-blocking cross-tenant test suite. Lint/review rule against raw pool usage.
- Revisit when: a large enterprise tenant requires physical isolation (it could get a dedicated database running the same code).
