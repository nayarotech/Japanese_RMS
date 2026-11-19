/**
 * Process entry point for the background worker service.
 *
 * PHASE 0 PLACEHOLDER. Nothing is started.
 *
 * Planned responsibility (apps/worker/README.md):
 *  - Load and validate configuration (packages/config).
 *  - Run the transactional-outbox relay and the PostgreSQL-backed job runner.
 *  - Run schedules through a mechanism that fires each schedule once across all replicas.
 *  - Set tenant context per job from the persisted job record, never from external input.
 *  - Expose a health endpoint and shut down gracefully (finish or release leased jobs).
 */
export {};
