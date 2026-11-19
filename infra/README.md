# infra/

Everything needed to build and run the platform as containers. No business logic and no secrets.

| Directory     | Responsibility                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| `docker/`     | Multi-stage, non-root Dockerfiles for `api`, `worker`, `web`. Build context is always the repo root.           |
| `compose/`    | Local development stack (PostgreSQL, Redis, optional app containers + proxy) and local-only DB role bootstrap. |
| `proxy/`      | Reverse-proxy routing contract (`/api`, `/socket.io`, `/`) as an nginx config for local use.                   |
| `deployment/` | Production-oriented templates and the target hosting design (managed DB/Redis, LB, replicas).                  |
| `monitoring/` | Observability plan: logs, metrics, traces, alerts, dashboards.                                                 |

**Status:** Templates only. Nothing has been built, started or deployed. Application images will build
once each app has dependencies, a lockfile entry and real sources (Phase 1).
