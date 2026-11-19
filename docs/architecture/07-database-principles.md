# G. Database design principles

PostgreSQL (target major version 18) is the system of record. Query builder: **Kysely** on `pg`.
Migrations: Kysely's migrator (TypeScript, forward-only in production) run as a separate one-off task.
No tables exist yet. This document sets the rules the first migrations must follow.

## Roles and connections

| Role                     | Used by                                    | Privileges                                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rp_migrator`            | Migration task only                        | Owns schema `app`. DDL. Not used by running services.                                                                                                                                                                        |
| `rp_app`                 | api, worker                                | DML on `app` tables via default privileges; **no DDL, no `BYPASSRLS`**, `INSERT`/`SELECT` only on append-only tables (audit, subscription events). Role-level `statement_timeout` and `idle_in_transaction_session_timeout`. |
| (optional) `rp_readonly` | Reporting replicas, ad-hoc support queries | `SELECT` with RLS, through audited access only.                                                                                                                                                                              |

The local bootstrap (`infra/compose/postgres/init/01-roles.sh`, created) implements this layout for development.
Production roles are provisioned by infrastructure tooling, with passwords in the secret manager. TLS is
`verify-full` and the DB is reachable only on a private network.

**Pooling:** one bounded `pg.Pool` per process (`DATABASE_POOL_MAX`). Never per tenant, device or socket.
Budget: `api_replicas × pool_max + worker_replicas × pool_max + migration/admin headroom ≤ ~80% of max_connections`.
PgBouncer (transaction mode) is optional later. Our tenant context uses `set_config(..., true)` inside
transactions, which is compatible with transaction pooling. Session-level `SET` is forbidden for that reason.

## Identifiers and common columns

- Primary keys: **UUIDv7** (`uuidv7()` is built into PostgreSQL 18). Time-ordered for index locality, and not enumerable.
- Tenant-owned tables: `tenant_id` (and `location_id` for operational data), `created_at`, `updated_at`
  (`timestamptz`, stored in UTC), and `version integer` where optimistic concurrency is needed.
- Human-facing numbers (order number, receipt number) are separate, per-location sequences (allocated
  in-transaction from a counter row). They are never derived from the PK. Whether receipt numbers must be gapless is part of the invoice spec.

## Normalization and denormalization

Normalized transactional schema first (3NF where sensible). **Snapshots are not denormalization; they are
business facts.** Order items copy product name, unit price, tax category and tax rate at order time.
Reporting summary tables are added only when `pg_stat_statements` and load tests show they are needed,
built by worker jobs from outbox events.

## Constraints enforce invariants

- `NOT NULL`, `CHECK` (for example `quantity > 0`, `amount_yen >= 0`, enum-like `CHECK (status IN (…))` or PG enums for stable sets).
- Composite FKs including `tenant_id` (see 03-tenant-isolation.md).
- Unique and partial unique indexes for business rules, for example:
  - one open table session per table: `UNIQUE (tenant_id, table_id) WHERE closed_at IS NULL`;
  - idempotency: `UNIQUE (tenant_id, idempotency_key)` on the idempotency table;
  - one current subscription per subject: partial unique on active statuses.
- Exclusion constraints where time ranges must not overlap (for example subscription periods per subject).

## Money and tax

- **Integer yen** (`bigint`). JPY has no minor unit. Any currency other than JPY would need an explicit minor-unit design.
- No JavaScript floating point in authoritative calculations. Use integer arithmetic with explicit rounding helpers in `orders/domain`.
- Tax: consumption tax rates (for example standard and reduced) are **configuration with effective dates**, not constants.
  Rounding mode (floor, round or ceil) and level (per line vs. per rate per receipt, as required for qualified invoices)
  must be **specified and approved** before implementation. The design stores per-line tax category and rate,
  and per-receipt totals per rate.
- Totals are always computed by the server, persisted, and covered by tests.

## Transactions and concurrency

| Concern                 | Approach                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| Default isolation       | `READ COMMITTED`, with explicit locking where needed. `SERIALIZABLE` only for specific use cases, with retry.  |
| Short transactions      | No network calls (email, payment gateways, partner APIs) inside a DB transaction. Use outbox and jobs instead. |
| Concurrent order edits  | Optimistic: `UPDATE … WHERE id = $1 AND version = $2`. Zero rows means 409 Conflict, and the client refetches. |
| Checkout / payment      | Pessimistic: `SELECT … FOR UPDATE` on the order or table session row, re-verify state, write payment, commit.  |
| Duplicate submissions   | `Idempotency-Key` header stored with request hash and response. Replays return the stored response.            |
| Limits (devices, staff) | Lock the subscription or counter row, count, insert, all in one transaction.                                   |
| Outbox / job claiming   | `FOR UPDATE SKIP LOCKED` batches.                                                                              |
| Deadlocks               | Consistent lock ordering per use case; automatic bounded retry on `40P01`/`40001`.                             |

## Indexing

- Index for **actual query patterns**, leading with `tenant_id` (and `location_id`). Example: `orders (tenant_id, location_id, business_date, created_at DESC)`.
- Partial indexes for hot subsets (`WHERE status IN ('placed','served')` for open orders).
- Every FK column used in joins gets an index. No blanket indexing of every column.
- Review with `EXPLAIN (ANALYZE, BUFFERS)` on realistic data volumes before shipping a heavy query.

## Query practices

- **Cursor (keyset) pagination** on `(created_at, id)`. No `OFFSET` for large lists.
- Avoid N+1 queries: batch-load with `WHERE id = ANY($1)` or joins, and fetch aggregates in one query.
- Select explicit columns. Set statement timeouts per role and lower ones for public endpoints.
- Large exports stream from cursors in worker jobs, never in request handlers.

## Operations

- `pg_stat_statements` enabled; slow query log threshold (for example 250 ms) in staging and production; `auto_explain` in staging.
- Autovacuum tuned for high-churn tables (outbox, sessions, idempotency keys), with retention jobs to purge processed rows.
- Partitioning (for example outbox or audit by month) only when table size or maintenance metrics justify it.
- Read replica for heavy reporting when the primary's load requires it. The reporting module is already isolated, which makes the switch easy.
- Backups: managed PITR plus periodic **restore drills** (see docs/operations).
