# Technology stack and versions

Checked against the npm registry and Node.js release index on 2026-11-19. Versions marked **installed** are
in the root `package.json` (exact pins + lockfile). Everything else is **planned**: pin exact versions at
install time in Phase 1, choosing releases that are at least two weeks old.

## Runtime and tooling

| Item       | Version                            | Status    | Notes                                                                                                             |
| ---------- | ---------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------- |
| Node.js    | **26 LTS** ("Lithium")             | Target    | Docker base images and `.nvmrc`. `engines` also accepts 24 LTS (maintenance) so existing dev machines work.       |
| pnpm       | 10.34.9                            | Pinned    | `packageManager` field. Installed explicitly in Docker because Node ≥ 25 no longer bundles Corepack.              |
| TypeScript | **6.0.3**                          | Installed | TypeScript 7 (native) exists, but `typescript-eslint` 8.x supports `<6.1`. Revisit when typed linting supports 7. |
| ESLint     | 10.14.0 + typescript-eslint 8.72.0 | Installed | Flat config, `strictTypeChecked`, architecture-guard import rules.                                                |
| Prettier   | 3.9.10                             | Installed | Formatting only.                                                                                                  |

## Backend (planned)

| Package                                                         | Line at time of writing | Purpose                                                                |
| --------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------- |
| express                                                         | 5.x                     | HTTP framework (v5: native async error propagation).                   |
| zod                                                             | 4.x                     | Validation of input, config and event payloads; shared contracts.      |
| pg                                                              | 8.x                     | PostgreSQL driver and bounded pool.                                    |
| kysely                                                          | 0.29.x                  | Type-safe query builder + migrator. No ORM magic.                      |
| socket.io / @socket.io/redis-adapter / @socket.io/redis-emitter | 4.8.x / 8.x             | Real-time with cross-instance fan-out.                                 |
| redis (node-redis) or ioredis                                   | 6.x                     | Redis client (pick one, matching adapter docs).                        |
| pino                                                            | 10.x                    | Structured JSON logging with redaction.                                |
| helmet                                                          | 8.x                     | Security headers.                                                      |
| rate-limiter-flexible                                           | current                 | Redis-backed distributed rate limiting.                                |
| Auth library                                                    | see ADR-0006            | Better Auth (1.x) is the leading candidate. Final decision in Phase 2. |
| @node-rs/argon2                                                 | 2.x                     | Argon2id password hashing, if not provided by the chosen auth library. |
| Job queue                                                       | see ADR-0004            | graphile-worker (0.18.x) preferred; pg-boss as alternative.            |

## Frontend (planned)

| Package           | Line  | Purpose                                                      |
| ----------------- | ----- | ------------------------------------------------------------ |
| next              | 16.x  | App Router, Server Components, standalone output for Docker. |
| react / react-dom | 19.x  |                                                              |
| tailwindcss       | 4.x   | Styling driven by CSS variables (brand tokens).              |
| next-intl         | 4.x   | i18n (ja/en).                                                |
| socket.io-client  | 4.8.x | Real-time client.                                            |
| zod               | 4.x   | Form and response validation via shared contracts.           |

## Data and infrastructure

| Item       | Version / choice                           | Notes                                                                 |
| ---------- | ------------------------------------------ | --------------------------------------------------------------------- |
| PostgreSQL | 18                                         | Native `uuidv7()`. Managed service in production.                     |
| Redis      | 8 (local); managed Redis or Valkey in prod | Non-authoritative. Check managed-service licensing and compatibility. |
| nginx      | 1.28 (local proxy only)                    | Production: managed load balancer + WAF.                              |

## Testing (planned)

Vitest 5.x, Supertest, Playwright 1.x, k6, Testing Library, axe-core. See 12-testing-strategy.md.

## Explicitly not used (initially)

Kafka, microservices, Kubernetes, Elasticsearch/Typesense, event sourcing, per-tenant databases, service mesh,
an ORM with implicit lazy loading, a DI container framework.
