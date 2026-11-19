# restaurant-platform

Multi-tenant, white-label, subscription-based restaurant management platform (POS, table management,
QR ordering, online ordering with pickup/delivery, reporting) for the Japanese market.

> **Internal repository.** `restaurant-platform` is a neutral internal name. The customer-facing product name,
> logos and all other branding are configured at runtime by authorized platform administrators and are never
> hard-coded. See [docs/architecture/05-white-label-branding.md](docs/architecture/05-white-label-branding.md).

## Status: Phase 0 (architecture and scaffolding)

| Exists now                                                                            | Documented only (not implemented)                                                      |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| pnpm workspace, strict TypeScript, ESLint (with architecture import guards), Prettier | Every business module, every API route, authentication, database tables and migrations |
| App/package shells with placeholder entry files                                       | Subscription/entitlement logic, WebSocket events, background jobs, UI pages            |
| Dockerfile templates, local Compose (PostgreSQL 18, Redis 8), nginx routing contract  | Production deployment, monitoring, backups                                             |
| Local DB role bootstrap (migrator vs. app role, no tables)                            | RLS policies, schema                                                                   |
| CI: format, lint, typecheck, brand-leak check, dependency audit, secret scan          | Integration/security tests, image scanning, deployments                                |
| Architecture docs, ADRs, module responsibility READMEs                                | Any validation of security, scalability or performance                                 |

No security property, scaling behaviour or feature has been validated. The documents describe intent.

## Repository layout

```
apps/
  api/        Express 5 + Socket.IO modular monolith (business modules live here)
  worker/     Background worker: outbox relay, durable jobs, schedules
  web/        Next.js App Router: platform admin, restaurant admin, POS, QR + online ordering
packages/
  contracts/  Shared Zod schemas / types for HTTP + WebSocket contracts
  config/     Validated runtime configuration from environment variables
infra/
  docker/     Multi-stage, non-root Dockerfiles (api, worker, web)
  compose/    Local development stack + local DB role bootstrap
  proxy/      Reverse-proxy routing contract (nginx, local)
  deployment/ Production-oriented templates and target topology
  monitoring/ Observability plan
docs/
  architecture/  Architecture documents A–K and supporting docs
  decisions/     Architecture Decision Records (ADRs)
  security/      Security architecture
  api/           API conventions
  operations/    Runbooks (planned)
scripts/      Repository scripts (brand-leak check)
.github/      CI workflow, Dependabot
```

Start with [docs/architecture/README.md](docs/architecture/README.md).

## Prerequisites

- Node.js 26 LTS (`.nvmrc`; 24 LTS also accepted), pnpm 10 (`packageManager` field), Docker with Compose v2.

## Common commands

```sh
pnpm install            # install workspace dev tooling
pnpm verify             # format check + lint + typecheck + tests
pnpm check:brand        # white-label leak check (needs BRAND_DENYLIST env var)

cp .env.example .env    # local only; never commit .env
docker compose -f infra/compose/compose.yaml --env-file .env up -d     # PostgreSQL + Redis
docker compose -f infra/compose/compose.yaml --env-file .env down      # stop (add -v to wipe local data)
```

App containers (`--profile apps`) will build once the apps are implemented in Phase 1.

## Ground rules

1. Backend is the only enforcement point for authentication, authorization, tenant isolation and entitlements.
2. Tenant identity always comes from the authenticated session, never from client input.
3. PostgreSQL is the source of truth. Redis is disposable.
4. Money is integer yen, calculated server-side.
5. No developer branding anywhere customer-facing.
6. No secrets in Git.
7. Keep it simple: add abstractions, dependencies and infrastructure only when a real requirement justifies them.
