# 0005. Worker reuses business-module code by importing an explicit export of the API package

- **Status:** Proposed
- **Date:** 2026-11-19
- **Related:** apps/worker/README.md, apps/api/README.md

## Context

The worker is a separate deployable, but its jobs need business logic that lives in `apps/api/src/modules`
(for example notifications, subscription expiry, report generation). Duplicating that logic is unacceptable.

## Options considered

1. **Worker depends on `@restaurant-platform/api` via an explicit `exports` subpath (`./jobs`)** that re-exports module job handlers and the composition needed to build them. The API never imports the worker.
2. Extract all modules into `packages/core`, with `apps/api` and `apps/worker` both as thin shells. Cleaner layering, but a larger structure up front and a deviation from the requested layout.
3. One app, two entrypoints (`server.ts`, `worker.ts`). Simplest, but blurs the separate-worker boundary in packaging and images.

## Decision

Option 1 for now. Job handlers live in `modules/<name>/jobs/`. The API package exposes only what the worker needs
through `exports["./jobs"]`. HTTP and Socket.IO bootstrapping are never part of that export.

## Consequences

- Positive: keeps the requested structure, no duplication, one-way dependency.
- Negative: worker image includes API code (but not its HTTP entrypoint execution). The build order is api → worker.
- Revisit when: the export surface grows awkward or a second consumer appears. Then move to Option 2 (mechanical refactor, since modules are already self-contained).
