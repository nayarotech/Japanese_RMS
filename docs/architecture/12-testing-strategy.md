# Testing strategy

No tests exist yet (Phase 0). Tools below are **choices to install in Phase 1**.

| Type                                                          | Tool                                                                                                                     | Location                     | Runs                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------- | ------------------------- |
| Unit (domain rules, totals, entitlement resolution, policies) | **Vitest**                                                                                                               | Colocated `*.test.ts`        | Every PR                  |
| Integration (use cases + real PG with RLS, Redis)             | Vitest + PostgreSQL/Redis service containers (CI) or Compose (local). Testcontainers optional                            | `apps/api/test/integration`  | Every PR                  |
| API contract                                                  | Vitest + **Supertest** against the Express app factory                                                                   | `apps/api/test/api`          | Every PR                  |
| **Cross-tenant security**                                     | Vitest, generated per route / event / job / export                                                                       | `apps/api/test/security`     | Every PR (merge-blocking) |
| Authorization matrix                                          | Table-driven: role × permission × endpoint                                                                               | `apps/api/test/security`     | Every PR                  |
| Entitlements                                                  | Plan/override/limit/state scenarios, enforcement on HTTP/WS/jobs                                                         | `apps/api/test/entitlements` | Every PR                  |
| Concurrency                                                   | Parallel requests against real PG (double checkout, concurrent edits, idempotent replays, limit races)                   | `apps/api/test/concurrency`  | Every PR                  |
| WebSocket                                                     | `socket.io-client` against **two API instances + Redis** (cross-instance delivery, room authorization, reconnect resync) | `apps/api/test/websocket`    | Every PR                  |
| Worker                                                        | Handlers run twice must yield the same result; outbox relay with competing workers                                       | `apps/worker` tests          | Every PR                  |
| Frontend components                                           | Vitest + Testing Library; accessibility checks (axe)                                                                     | `apps/web`                   | Every PR                  |
| End-to-end                                                    | **Playwright** (POS flow, QR order, admin plan change, per-brand rendering)                                              | `apps/web/e2e` (planned)     | Main branch + nightly     |
| Load                                                          | **k6** (HTTP + WebSocket peak scenarios)                                                                                 | `tests/load` (planned)       | Before scale milestones   |
| DAST                                                          | OWASP ZAP baseline against staging                                                                                       | CI scheduled                 | Nightly / weekly          |
| SAST / deps / secrets / images                                | CodeQL, `pnpm audit` + Dependabot, gitleaks, Trivy                                                                       | CI                           | Every PR / scheduled      |

## Policies

1. Integration tests connect as the **runtime role** (`rp_app`, RLS enforced), never as a superuser. Otherwise RLS is not tested.
2. Every new tenant-scoped table ships with an RLS policy and a test proving cross-tenant reads and writes fail.
3. Every new route, socket event, job or export is registered in the cross-tenant suite. A coverage check fails CI if one is missing.
4. Money calculations are tested with table-driven cases, including rounding edge cases from the approved tax spec.
5. Tests own their data (factories per test, transactional cleanup or per-run schemas). No shared mutable fixtures.
