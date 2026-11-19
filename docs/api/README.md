# API conventions (planned)

These conventions apply to every module once implementation starts. No endpoints exist yet.

| Topic          | Convention                                                                                                                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base path      | `/api/v1/...`. Platform operations under `/api/v1/platform/...`. Unauthenticated brand/QR endpoints under `/api/v1/public/...`.                                                                                   |
| Resource scope | Location-scoped resources nest under `/api/v1/locations/:locationId/...`. The tenant is **never** in the URL; it comes from the session.                                                                          |
| Validation     | Zod schemas for params, query and body. Unknown fields rejected (`strict`). Size limits on bodies and arrays.                                                                                                     |
| Money          | Integer yen fields suffixed `_yen` (`total_yen`). Clients never send prices or totals for authoritative use.                                                                                                      |
| Time           | ISO 8601 UTC timestamps. `business_date` as `YYYY-MM-DD`.                                                                                                                                                         |
| Errors         | `{ "error": { "code": "feature_not_entitled", "message": "…", "requestId": "…", "details"?: [...] } }`. Stable `code`s, translated by the client. No stack traces.                                                |
| Status codes   | 400 validation, 401 unauthenticated, 403 forbidden / not entitled, 404 not found (also for other tenants' resources), 409 version conflict / idempotency mismatch, 422 business rule violation, 429 rate limited. |
| Idempotency    | `Idempotency-Key` header required on order, payment, refund and other non-idempotent creates. The same key with a different payload returns 409.                                                                  |
| Concurrency    | Mutable resources expose `version`. Updates send `If-Match: <version>` or `version` in the body. A mismatch returns 409.                                                                                          |
| Pagination     | Cursor-based: `?limit=50&cursor=…`, returns `{ data, nextCursor }`. No offset pagination on large collections.                                                                                                    |
| CSRF           | State-changing requests require the CSRF token header (see security architecture).                                                                                                                                |
| Rate limits    | `RateLimit-*` headers (IETF draft) on limited routes.                                                                                                                                                             |
| Contracts      | Request/response schemas shared via `@restaurant-platform/contracts`.                                                                                                                                             |

## Public API documentation

If an API is ever published to partners or restaurants, documentation is generated from the Zod contracts
(OpenAPI) and rendered with **brand variables only**, under the brand domain, with no developer identity.
