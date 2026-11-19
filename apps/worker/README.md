# apps/worker

Separate deployable for **background processing**. Same repository and toolchain as the API, different process and scaling profile.

## Responsibilities (planned)

| Area                | Behaviour                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outbox relay        | Reads committed `outbox` rows (`FOR UPDATE SKIP LOCKED`), publishes real-time events via the Socket.IO Redis emitter, enqueues follow-up jobs, marks rows processed.            |
| Durable jobs        | PostgreSQL-backed queue (library decision in ADR-0004). At-least-once delivery, so **every handler is idempotent**.                                                             |
| Schedules           | Subscription expiry checks, partner reconciliation, sales summaries, cleanup. Each schedule fires once across all replicas (DB-coordinated, never a per-process `setInterval`). |
| Notifications       | Email delivery with retry and dedupe keys.                                                                                                                                      |
| Reports and exports | Large report generation written to object storage, then a signed URL is delivered.                                                                                              |

## Rules

- Tenant context for a job comes from the **persisted job/outbox row** written by trusted server code, and is applied with the same `withTenantTransaction` used by the API (RLS stays on).
- Entitlements are re-checked when a job runs (a feature may have been revoked since enqueue).
- External calls run outside DB transactions, with timeouts and bounded retries (exponential backoff, dead-letter after N attempts).
- Graceful shutdown: stop leasing, finish or release in-flight jobs within the grace period.

## Layout

`src/main.ts` is the entry point (placeholder). Planned: `src/runtime/` (job runner, outbox relay loop,
scheduler, health server). Job **handlers** live in the owning API module's `jobs/` folder and are imported
via `@restaurant-platform/api/jobs` (ADR-0005).

**Status:** Phase 0. Nothing is implemented.
