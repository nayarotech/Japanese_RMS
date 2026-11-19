# apps/api

Express 5 + Socket.IO service implementing the **modular monolith**. Stateless and horizontally scalable:
the same image runs as N replicas behind a load balancer.

| Path                  | Responsibility                                                                 |
| --------------------- | ------------------------------------------------------------------------------ |
| `src/server.ts`       | Process entry: config, pools, HTTP + Socket.IO, health, graceful shutdown.     |
| `src/app.ts`          | Express app factory (no I/O at import).                                        |
| `src/app/`            | Composition root: wiring, route mounting, socket registration.                 |
| `src/modules/`        | Business capabilities (one folder each). See its README.                       |
| `src/infrastructure/` | Shared technical adapters (DB, Redis, WS, security, logging, storage, outbox). |
| `src/shared/`         | Minimal cross-cutting code (errors, generic middleware, base types).           |
| `test/`               | Infrastructure-backed tests (integration, security, concurrency, WS).          |

**Status:** Phase 0. Entry files are placeholders. No routes, auth, DB access or sockets are implemented.

Dependencies will be added in Phase 1 (versions to confirm at install time; see
`docs/architecture/13-tech-stack.md`): express, socket.io, @socket.io/redis-adapter, pg, kysely, zod, pino, an auth library.

**Worker access:** `apps/worker` imports module job handlers from this package through an explicit
`exports` subpath (`@restaurant-platform/api/jobs`) added when the first job exists. The API never imports the worker. See ADR-0005.
