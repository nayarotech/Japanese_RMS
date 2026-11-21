# restaurant-platform

Multi-tenant, white-label restaurant management platform for the Japanese market: table management, QR ordering,
POS, kitchen display, waiter app, cash checkout, and online ordering with pickup and delivery.

> `restaurant-platform` is a neutral internal name. The customer-facing product name, logo and colors come from the
> brand configuration at runtime and are never hard-coded. See [docs/architecture/05-white-label-branding.md](docs/architecture/05-white-label-branding.md).

## What works today (Phase 1: dine-in, Basic package)

1. Staff seat guests, or a guest scans the table's QR and the table opens automatically.
2. Guests order from their phone (no app, no account). Each item can carry its own note ("less spicy", "extra noodles").
3. Orders appear live on the POS and the kitchen screen.
4. The kitchen marks items ready one by one, and the waiter gets a live "food ready" alert and marks them served.
5. Guests can keep ordering on the same table, and the cashier sees one combined bill.
6. Cash checkout with change calculation and a receipt. The table becomes free again.

## Phase 2: online ordering, pickup and delivery (Standard package)

1. Customers open the restaurant's ordering link (no account), add dishes with per-item notes, and choose **pickup** (a time slot) or
   **delivery** (address checked on the server: distance, fee, minimum).
2. The order appears live on the **Online** screen. Staff accept it (it goes to the same kitchen display) or decline it with a reason.
3. Kitchen progress updates the order; the customer follows it on a status page.
4. Pickup: hand over and take the cash in one step. Delivery: dispatch, mark delivered, and record the cash separately
   (delivered never means paid).
5. Managers configure hours, pickup timing, minimums, the delivery area and fees, and can pause ordering. Basic plans cannot use any of it.

Japanese and English UI. All prices, tax and totals are calculated on the server.

## Tech stack

Next.js 16 (App Router, React 19, Tailwind 4) · Express 5 · PostgreSQL 18 (Kysely, row-level security) · Redis 8 ·
Socket.IO · TypeScript 6 · pnpm workspaces · Docker · Vitest.

```
apps/api       Express API + Socket.IO (business modules in src/modules)
apps/worker    Background worker: relays saved events to live screens
apps/web       Next.js frontend: staff screens + guest QR menu
packages/      Shared config and API types
infra/         Dockerfiles, Docker Compose, nginx
docs/          Architecture, decisions (ADRs), security, operations
```

## Requirements

- **Node.js 24 or 26** (`node -v`)
- **pnpm 10**: `npm install -g pnpm@10`
- **Docker Desktop** (with Docker Compose)

## How to run (local)

### 1. Install and configure

```sh
git clone https://github.com/nayarotech/Japanese_RMS.git
cd Japanese_RMS
pnpm install
cp .env.example .env
```

Edit `.env`:

- Set `SESSION_SECRET` to a random value of at least 32 characters: `openssl rand -base64 48`
- If port **6379** is already used on your machine, set `REDIS_PORT=6380` and `REDIS_URL=redis://localhost:6380`
- If port **5432** is already used, change `POSTGRES_PORT` the same way

### 2. Start PostgreSQL and Redis

```sh
docker compose -f infra/compose/compose.yaml --env-file .env up -d
```

### 3. Create the database and demo data

```sh
pnpm --filter @restaurant-platform/api db:reset   # creates roles, schema and tables (local only)
pnpm --filter @restaurant-platform/api db:seed    # demo store, staff accounts, 12 tables, menu
```

The seed prints a guest QR link for table A-3 (`http://localhost:3000/t/...`) and the online ordering link
(`http://localhost:3000/order/...`). The demo store is on the Standard plan. Delivery uses built-in demo postal codes
(`GEOCODER_PROVIDER=static_demo`, local only): `1500002` (free), `1510053` (¥300), `1000005` (outside the area).

Already have a database from Phase 1? Run `pnpm --filter @restaurant-platform/api db:migrate` (keeps your data), or
reset and re-seed to get the online demo setup.

### 4. Start the apps (3 terminals)

```sh
pnpm --filter @restaurant-platform/api dev       # API      → http://localhost:4000
pnpm --filter @restaurant-platform/worker dev    # live updates
pnpm --filter @restaurant-platform/web dev       # Frontend → http://localhost:3000
```

### 5. Open it

- **Staff:** http://localhost:3000/login
  - Accounts: `owner@demo.example.test`, `manager@…`, `cashier@…`, `waiter@…`, `kitchen@…` (all `@demo.example.test`)
  - The local demo password is in `apps/api/src/infrastructure/database/seed-dev.ts`
- **Guest:** open the QR link printed by the seed, or go to **Table QR** → select a table → _Preview customer screen_.
  Use a private window or a phone so the guest and staff sessions don't mix.

| Screen               | Path                   | Who                                                        |
| -------------------- | ---------------------- | ---------------------------------------------------------- |
| Table map            | `/tables`              | owner, manager, cashier, waiter                            |
| POS / order entry    | `/pos/:sessionId`      | owner, manager, cashier, waiter                            |
| Checkout             | `/checkout/:sessionId` | owner, manager, cashier                                    |
| Kitchen              | `/kitchen`             | owner, manager, kitchen                                    |
| Floor (waiter phone) | `/floor`               | owner, manager, waiter                                     |
| Table QR codes       | `/admin/tables`        | owner, manager                                             |
| Menu                 | `/admin/menu`          | owner, manager                                             |
| Online orders        | `/online`              | owner, manager, cashier, waiter (settings: owner, manager) |
| Guest menu           | `/t/:qrToken`          | customers                                                  |
| Online ordering      | `/order/:storeToken`   | customers                                                  |
| Order status         | `/order/status#token`  | customers (link shown after ordering)                      |

### Stop / reset

```sh
docker compose -f infra/compose/compose.yaml --env-file .env down       # stop
docker compose -f infra/compose/compose.yaml --env-file .env down -v    # stop and delete local data
pnpm --filter @restaurant-platform/api db:reset && pnpm --filter @restaurant-platform/api db:seed   # fresh demo data
```

## Tests and checks

```sh
pnpm --filter @restaurant-platform/api test   # 150 tests against real PostgreSQL + Redis (Docker must be running)
pnpm lint
pnpm typecheck
pnpm verify                                    # format + lint + typecheck + tests
pnpm build                                     # production builds
```

Tests create their own database (`restaurant_platform_test`) on every run and never touch your demo data.

## Run with Docker (all services)

```sh
docker compose -f infra/compose/compose.yaml --env-file .env --profile apps up --build
```

The app is served through nginx at http://localhost:8080. For this mode, set `APP_PUBLIC_ORIGINS=http://localhost:8080`
and leave `NEXT_PUBLIC_SOCKET_URL` empty in `.env`.

## Not yet included

MFA and password recovery, staff management screens, split bills and discounts, card / e-money / QR payments,
a real geocoding provider for delivery (delivery is refused until one is chosen), online-order receipts and refunds,
customer email/SMS notifications, reports, subscription management, and production deployment. Japanese text and the
tax/receipt rules (including 8% takeout / 10% delivery fee) still need partner approval.

## Documentation

- Dine-in feature reference (data model, API, events, permissions): [docs/architecture/14-dine-in-workflow.md](docs/architecture/14-dine-in-workflow.md)
- Online ordering reference: [docs/architecture/15-online-ordering.md](docs/architecture/15-online-ordering.md), security: [docs/security/online-ordering.md](docs/security/online-ordering.md)
- QR ordering rules: [docs/security/qr-ordering.md](docs/security/qr-ordering.md)
- Architecture overview: [docs/architecture/README.md](docs/architecture/README.md)
- Decisions: [docs/decisions/README.md](docs/decisions/README.md)
- Detailed local guide: [docs/operations/local-development.md](docs/operations/local-development.md)
