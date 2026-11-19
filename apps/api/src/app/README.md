# src/app/

**Composition root.** The only place that wires modules and infrastructure together.

Planned contents:

- `container.ts`: builds module services with explicit constructor or function arguments (no DI framework, no service locator).
- `routes.ts`: mounts each module's `http/` router under `/api/v1` (`/api/v1/platform/*` for platform-admin).
- `socket.ts`: registers Socket.IO namespaces and connection middleware (auth, room joining).
- `health.ts`: `/health/live` (process up) and `/health/ready` (DB and Redis reachable, not shutting down).

Rule: business logic never lives here. If a file in `app/` grows an `if` about restaurants, it belongs in a module.
