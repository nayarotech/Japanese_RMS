# @restaurant-platform/config

Single place where **runtime configuration** is read and validated, so no module calls `process.env` directly.

Planned behaviour:

- Parse `process.env` with a Zod schema at startup; **exit with a clear error** on missing or invalid values.
- Return a frozen, typed config object passed explicitly into `server.ts` and `main.ts` (no global singleton imports in business code).
- Enforce production guards: `COOKIE_SECURE=true`, `DATABASE_SSL_MODE=verify-full`, `LOG_PRETTY=false`, and the migrator credential never loaded by api or worker.
- Variables: see the root [`.env.example`](../../.env.example).

Consumed by: `apps/api`, `apps/worker`. (The web app reads only the few server-side variables it needs.)
**Status:** Phase 0 placeholder.
