# syntax=docker/dockerfile:1
# Worker image (outbox relay, durable jobs, schedules). Build context: repository root.
#   docker build -f infra/docker/worker.Dockerfile -t restaurant-platform/worker .
# TEMPLATE (Phase 0). The worker depends on @restaurant-platform/api for job handlers (ADR-0005).

ARG NODE_IMAGE=node:26-trixie-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN npm install -g pnpm@10.34.9 && npm cache clean --force
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/worker/package.json apps/worker/
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
COPY packages/config/package.json packages/config/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@restaurant-platform/worker..."
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY packages/config packages/config
COPY apps/api apps/api
COPY apps/worker apps/worker
RUN pnpm --filter "@restaurant-platform/worker..." run build \
 && pnpm --filter @restaurant-platform/worker deploy --legacy --prod /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.WORKER_HEALTH_PORT||4100)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
