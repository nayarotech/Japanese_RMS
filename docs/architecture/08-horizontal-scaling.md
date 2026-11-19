# I. Horizontal scaling

## Goal

The **same images** run as 1 or N replicas. Scaling is configuration (replica counts, instance sizes,
pool sizes), never a code change. No instance owns a restaurant.

Business targets: pilot of about 100 restaurants, growth to 2,000+. These are planning targets, **not
benchmarks**. Capacity must be proven by load tests before each growth step.

## Statelessness checklist (applies to api, worker, web)

| Must not                                     | Instead                                                            |
| -------------------------------------------- | ------------------------------------------------------------------ |
| Keep sessions in memory                      | Server-side sessions in PostgreSQL (optionally cached in Redis)    |
| Keep orders or carts in memory               | PostgreSQL. Customer carts client-side until submit, or in DB      |
| Emit WebSocket events only locally           | Redis adapter / emitter                                            |
| Write uploads or exports to local disk       | Object storage via signed URLs (`read_only` root FS in containers) |
| Run schedules with `setInterval` per process | DB-coordinated scheduler in the worker (one firing cluster-wide)   |
| Rate-limit with in-memory counters           | Redis-backed limiter (in-memory only as a local fallback)          |
| Read instance identity in business logic     | `INSTANCE_NAME` is for logs and metrics only                       |

## Process lifecycle

- **Readiness** (`/health/ready`): DB reachable, Redis reachable (degraded mode allowed, see below), not draining.
- **Liveness** (`/health/live`): event loop responsive. Never checks dependencies (avoids restart storms).
- **SIGTERM:** mark not-ready, stop accepting HTTP and sockets, ask sockets to reconnect elsewhere, finish in-flight
  requests, close pools, then exit within the grace period (`SHUTDOWN_GRACE_PERIOD_MS`, below the orchestrator's kill timeout).
- **Worker SIGTERM:** stop claiming, finish or release leases, then exit.

## Degraded modes

| Dependency down | Behaviour                                                                                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Redis           | HTTP keeps working (core POS ordering and checkout). Real-time fan-out pauses, and clients fall back to polling/resync. Rate limiter falls back to stricter local limits. Alert. |
| Worker          | Writes keep succeeding. Outbox and jobs accumulate and drain when the worker returns (lag alert).                                                                                |
| PostgreSQL      | Service unavailable (correctly). Readiness fails, and the load balancer stops routing.                                                                                           |

## Growth path

| Stage  | Restaurants | Indicative topology (to validate)                                                       | Main work                                                                            |
| ------ | ----------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Pilot  | ~100        | api ×2, web ×2, worker ×1–2, managed PG (Multi-AZ, moderate size), managed Redis        | Correctness, observability baseline, first load test                                 |
| Growth | ~500        | api ×3–4, web ×2–3, worker ×2, PG scaled up                                             | Query tuning from `pg_stat_statements`, caching menus/brand/entitlements             |
| Scale  | 2,000+      | api ×6+, web ×3+, worker ×3+, larger PG, read replica for reporting, optional PgBouncer | Reporting read models, outbox/audit partitioning, autoscaling on CPU and connections |

Rough load model to test against (assumption, not data): about 30 orders/hour per busy location at peak. At
2,000 locations that is about 60k orders/hour, or about 17 orders/s, with several writes each. Plus reads, QR browsing and
about 10–20k idle sockets. This is moderate for a well-indexed PostgreSQL. The likely early bottlenecks are
connection budgets, report queries and hot menu reads, which is why pooling discipline, keyset pagination and
selective caching are designed in from the start.

## Load testing

k6 scenarios (lunch/dinner peak shape): POS order create/modify/checkout, QR browse and order, admin reports,
WebSocket connect/subscribe/receive. Run against staging with production-like data volumes. Record results in
`docs/operations/` and size replicas and pools from them.
