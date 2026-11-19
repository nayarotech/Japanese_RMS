# apps/api/test/

Tests that need real infrastructure. **Unit tests are colocated** next to source (`*.test.ts`).
Tooling decisions: [docs/architecture/12-testing-strategy.md](../../../docs/architecture/12-testing-strategy.md).

Planned layout (directories are created with their first test):

| Directory       | What it verifies                                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integration/`  | Use cases against a real PostgreSQL (migrated schema, RLS on, app role, not superuser).                                                             |
| `api/`          | HTTP contract tests via Supertest: status codes, validation, error shapes.                                                                          |
| `security/`     | **Cross-tenant isolation** (tenant A cannot read or write B through any route, socket room, job or export), authZ matrix, CSRF, session revocation. |
| `entitlements/` | Plan/feature/limit/override resolution and enforcement on HTTP, WS and jobs.                                                                        |
| `concurrency/`  | Parallel order edits, double checkout, idempotency-key replay, limit races.                                                                         |
| `websocket/`    | Socket auth, room authorization, multi-instance broadcast via Redis adapter, reconnection resync.                                                   |
| `helpers/`      | Factories, tenant fixtures, DB reset utilities.                                                                                                     |
