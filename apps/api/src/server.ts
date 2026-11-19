/**
 * Process entry point for the API service.
 *
 * PHASE 0 PLACEHOLDER. Nothing is started.
 *
 * Planned responsibility (docs/architecture/08-horizontal-scaling.md):
 *  - Load and validate configuration (packages/config). Fail fast on invalid config.
 *  - Create the bounded PostgreSQL pool and Redis clients.
 *  - Create the HTTP server from app.ts and attach Socket.IO with the Redis adapter.
 *  - Expose liveness (/health/live) and readiness (/health/ready) endpoints.
 *  - Handle SIGTERM: mark not-ready -> stop accepting connections -> drain Socket.IO
 *    -> finish in-flight requests -> close pools, within SHUTDOWN_GRACE_PERIOD_MS.
 *  - Hold no authoritative state in process memory: any replica can serve any tenant.
 */
export {};
