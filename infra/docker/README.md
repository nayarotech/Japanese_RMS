# infra/docker/

| File                | Image                         | Entrypoint                |
| ------------------- | ----------------------------- | ------------------------- |
| `api.Dockerfile`    | Express + Socket.IO           | `node dist/server.js`     |
| `worker.Dockerfile` | Outbox relay, jobs, schedules | `node dist/main.js`       |
| `web.Dockerfile`    | Next.js standalone server     | `node apps/web/server.js` |

Common properties: Node 26 LTS slim base, pnpm pinned to the root `packageManager`, `--frozen-lockfile`,
build cache mounts, production-only pruned output (`pnpm deploy`), **non-root `node` user**, liveness `HEALTHCHECK`,
no secrets in layers (all config via environment at runtime), and **one image per service for every environment**
(promote the same digest from staging to production).

Hardening to add in CI (Phase 1): pin base images by digest, Trivy image scan (fail on HIGH/CRITICAL with fixes),
SBOM generation, read-only root filesystem at runtime (`read_only: true` + tmpfs, as in compose).
