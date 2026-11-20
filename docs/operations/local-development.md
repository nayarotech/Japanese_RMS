# Local development

## Prerequisites

- Node.js 26 LTS (24 LTS also works), pnpm 10 (`corepack` is not bundled with Node ≥ 25: `npm i -g pnpm@10`), Docker with Compose v2.

## First run

```sh
pnpm install
cp .env.example .env                 # then set SESSION_SECRET (openssl rand -base64 48)
                                     # if 6379 is taken locally, set REDIS_PORT and REDIS_URL to e.g. 6380
docker compose -f infra/compose/compose.yaml --env-file .env up -d      # PostgreSQL 18 + Redis 8
pnpm --filter @restaurant-platform/api db:reset   # recreate DB, roles, schema, run migrations (local only)
pnpm --filter @restaurant-platform/api db:seed    # demo tenant, staff, 12 tables, menu (prints a guest QR URL)
```

## Run the apps (three terminals)

```sh
pnpm --filter @restaurant-platform/api dev        # http://localhost:4000 (Express + Socket.IO)
pnpm --filter @restaurant-platform/worker dev     # outbox relay -> real-time events
pnpm --filter @restaurant-platform/web dev        # http://localhost:3000 (proxies /api to the API)
```

Without the **worker**, writes still succeed but screens update only on refresh or the 15-second fallback poll.

## Demo walkthrough (about 5 minutes)

Demo logins are `owner|manager|cashier|waiter|kitchen@demo.example.test`. The local-only password is in
`apps/api/src/infrastructure/database/seed-dev.ts`.

1. Sign in as **owner** at `http://localhost:3000/login` and go to **Tables**. Select **A-3**, then **Seat guests** (2).
2. Open the guest URL printed by `db:seed` (or **Table QR** → A-3 → preview), ideally in a private window or on a phone on the same network.
   The phone joins the table automatically (scanning a free table opens it). Add **Shoyu ramen** twice, then use **Different request for one** to give each its own note (`Less spicy`, `Extra noodles`). Place the order.
3. **Kitchen**: the ticket shows both notes. **Start cooking**, then **Ready** on one item. The ticket stays in _Preparing_ (partial readiness).
4. **Floor**: the A-3 alert lists the ready item. Mark the other item ready and the alert updates live. **Serve all**.
5. Guest phone: statuses update to _Served_. Order **Matcha ice cream** (a second order on the same session).
6. **Tables → A-3 → Check out**: the combined bill (3 lines, tax breakdown). Tap ¥5,000, **Complete payment**, then view the **Receipt**.
7. A-3 is free again. The guest phone shows the bill as settled, and its credential can no longer order (a new party must scan again).

Note: staff and guest cookies are separate, but in one browser profile the guest page's socket authenticates as staff
(staff cookie takes precedence). Use a private window or a phone for a faithful guest experience.

## Tests

```sh
pnpm --filter @restaurant-platform/api test   # creates restaurant_platform_test from scratch each run
pnpm verify                                    # format + lint + typecheck + tests
```

## Containers

```sh
docker build -f infra/docker/api.Dockerfile -t restaurant-platform/api .
docker build -f infra/docker/worker.Dockerfile -t restaurant-platform/worker .
docker build -f infra/docker/web.Dockerfile -t restaurant-platform/web .
docker compose -f infra/compose/compose.yaml --env-file .env --profile apps up --build   # full stack behind nginx on :8080
```

For the full container stack, set `APP_PUBLIC_ORIGINS=http://localhost:8080` and `NEXT_PUBLIC_SOCKET_URL=` (empty, same origin).
