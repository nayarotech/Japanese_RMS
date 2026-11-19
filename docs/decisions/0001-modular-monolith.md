# 0001. Build a modular monolith (Express API + Next.js web + worker) on PostgreSQL and Redis

- **Status:** Proposed
- **Date:** 2026-11-19
- **Related:** docs/architecture/01-high-level.md, 02-module-boundaries.md

## Context

Small team, commercial product with strong consistency needs (orders, payments, subscriptions), a pilot of about 100
restaurants growing to 2,000+. Operational simplicity and debuggability matter more than independent deployability.

## Options considered

1. **Microservices**: independent scaling and deploys, but distributed transactions, network failure modes and heavy ops for a small team.
2. **Unstructured monolith**: fast start, but boundaries erode and become hard to change.
3. **Modular monolith**: one deployable API with enforced module boundaries, plus a separate worker process and a single Next.js app.

## Decision

Option 3. pnpm monorepo with `apps/api` (Express 5 + Socket.IO), `apps/worker`, `apps/web` (Next.js App Router),
and `packages/contracts` and `packages/config`. Modules communicate through public `index.ts` APIs and outbox events.

## Consequences

- Positive: ACID transactions across modules when needed, simple deployment, one codebase to debug.
- Negative: one API deploy unit. Boundaries rely on discipline + lint rules + review.
- Revisit when: a module has clearly different scaling or availability needs proven by metrics (reporting is the most likely first candidate, served via a read replica before any extraction).
