# infra/monitoring/

Observability plan. Nothing is configured yet. Tool choice depends on the hosting decision (managed cloud
tooling vs. Grafana stack vs. a SaaS APM); all apps emit vendor-neutral signals so the backend can change.

## Signals

| Signal  | Source                                                                                         | Notes                                                                                                                                                                   |
| ------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Logs    | Pino JSON to stdout, collected by the platform                                                 | Fields: `time, level, msg, requestId, tenantId, locationId, userId, route, durationMs`. Secrets, tokens and personal data are redacted.                                 |
| Metrics | OpenTelemetry (or Prometheus endpoint on a private port)                                       | HTTP rate/latency/errors per route, DB pool in-use/waiting, query duration, outbox lag, job queue depth/age/failures, Socket.IO connections per instance, Redis errors. |
| Traces  | OpenTelemetry SDK (HTTP, pg, Redis instrumentation)                                            | Propagate `traceparent` from web to api to outbox/job.                                                                                                                  |
| DB      | `pg_stat_statements`, slow query log (`log_min_duration_statement`), `auto_explain` in staging | Weekly review of top queries by total time.                                                                                                                             |

## Initial alerts (to tune after load testing)

- API 5xx rate > 1% for 5 min; p95 latency above SLO.
- DB pool waiting > 0 sustained; DB CPU or connections > 80%; replication lag.
- Outbox oldest unprocessed event age > 30 s; job dead-letter count increasing.
- Redis unavailable (real-time degraded, while core POS via HTTP must keep working).
- Auth anomalies: login failure spikes, MFA failures, platform-admin actions outside business hours.
- Certificate expiry; backup job failure; restore test overdue.
