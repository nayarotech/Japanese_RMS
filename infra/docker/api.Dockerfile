# syntax=docker/dockerfile:1
# API image (Express + Socket.IO). Build context: repository root.
#   docker build -f infra/docker/api.Dockerfile -t restaurant-platform/api .
# TEMPLATE (Phase 0): builds once apps/api has dependencies, a lockfile and real sources.
# Pin the base image by digest in CI before production use.

ARG NODE_IMAGE=node:26-trixie-slim

# ---- base: toolchain only ------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
# Corepack is no longer bundled with Node >= 25, so pnpm is installed explicitly (version = root packageManager).
RUN npm install -g pnpm@10.34.9 && npm cache clean --force
WORKDIR /repo

# ---- build: install, compile, prune ---------------------------------------------
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
COPY packages/config/package.json packages/config/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@restaurant-platform/api..."
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY packages/config packages/config
COPY apps/api apps/api
RUN pnpm --filter "@restaurant-platform/api..." run build \
 && pnpm --filter @restaurant-platform/api deploy --legacy --prod /out

# ---- runtime: minimal, non-root ---------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 4000
# Liveness only. Readiness (DB/Redis) is checked by the orchestrator via /health/ready.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# Run with an init process (compose `init: true` / ECS `initProcessEnabled`) so SIGTERM reaches Node for graceful shutdown.
CMD ["node", "dist/server.js"]
