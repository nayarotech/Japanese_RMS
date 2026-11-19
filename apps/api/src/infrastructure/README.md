# src/infrastructure/

Shared **technical** adapters used by many modules. No business rules here.

| Directory    | Responsibility                                                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `database/`  | `pg` pool (bounded), Kysely instance, `withTenantTransaction(ctx, fn)` that sets transaction-local tenant context for RLS, migration runner wiring. |
| `redis/`     | Redis clients (command + pub/sub), key naming conventions, health check.                                                                            |
| `websocket/` | Socket.IO server setup, Redis adapter, connection authentication, tenant/location room naming and join authorization.                               |
| `security/`  | Security headers, CSRF, CORS/Origin checks, rate limiter (Redis-backed), cookie settings, password hashing wrapper.                                 |
| `logging/`   | Pino logger, request-id propagation (AsyncLocalStorage), redaction list for secrets and personal data.                                              |
| `storage/`   | S3-compatible object storage client, signed URL generation, content-type and size validation.                                                       |
| `events/`    | Transactional outbox writer (`appendOutbox(tx, event)`), event envelope type, event name registry.                                                  |

Modules use these through small, explicit functions. Module-specific queries stay inside the module.
