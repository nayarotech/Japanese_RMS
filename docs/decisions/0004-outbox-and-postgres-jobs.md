# 0004. Transactional outbox and PostgreSQL-backed durable jobs (no Kafka)

- **Status:** Proposed (library choice open)
- **Date:** 2026-11-19
- **Related:** docs/architecture/06-realtime-websockets.md, apps/worker/README.md

## Context

Events (real-time updates, notifications, cache invalidation, reports) must never be emitted for uncommitted
changes and must not be lost when Redis or the worker is down. Volume is moderate.

## Decision

- Business transactions write domain events to an `outbox` table **in the same transaction**.
- The worker relays outbox rows (`FOR UPDATE SKIP LOCKED`) to Socket.IO (Redis emitter) and to durable jobs.
- Durable jobs live in PostgreSQL. Preferred library: **graphile-worker** (LISTEN/NOTIFY for low latency, SKIP LOCKED,
  cluster-safe cron, jobs can be enqueued in SQL within the business transaction). Alternative: **pg-boss**.
  Final choice in Phase 1 after a short spike.
- All handlers are idempotent (at-least-once delivery).

## Consequences

- Positive: no extra broker, transactional consistency, simple ops, durable.
- Negative: queue throughput is bounded by PostgreSQL. Processed rows need retention cleanup.
- Revisit when: sustained job throughput or latency metrics show PostgreSQL contention. Then consider a Redis-backed queue for specific non-critical workloads.
