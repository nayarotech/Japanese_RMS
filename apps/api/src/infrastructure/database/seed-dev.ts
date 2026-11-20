/**
 * Local development seed: `pnpm --filter @restaurant-platform/api db:seed`.
 * Refuses to run outside development. Uses the MIGRATOR credential.
 *
 * Demo staff logins (LOCAL ONLY): <role>@demo.example.test with password DEV_PASSWORD below,
 * where <role> is owner | manager | cashier | waiter | kitchen.
 */
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { createTenantFixture } from "./fixtures.js";
import type { Database } from "./schema.js";

const DEV_PASSWORD = "local-dev-password-2026";

const env = process.env["APP_ENV"] ?? "development";
if (env !== "development") throw new Error(`Refusing to seed demo data in APP_ENV=${env}`);

const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new pg.Pool({
      host: process.env["POSTGRES_HOST"],
      port: Number(process.env["POSTGRES_PORT"] ?? 5432),
      database: process.env["POSTGRES_DB"],
      user: process.env["DATABASE_MIGRATOR_USER"],
      password: process.env["DATABASE_MIGRATOR_PASSWORD"],
      max: 1,
    }),
  }),
});

try {
  const existing = await db
    .selectFrom("users")
    .select("id")
    .where("email", "=", "owner@demo.example.test")
    .executeTakeFirst();
  if (existing) {
    process.stdout.write("Demo data already present. Reset the database to re-seed.\n");
  } else {
    const f = await createTenantFixture(db, {
      slug: "demo",
      password: DEV_PASSWORD,
      brandHost: "localhost",
    });
    process.stdout.write(
      `Seeded demo tenant ${f.tenantId}\n` +
        `  location: ${f.locationId}\n` +
        `  staff logins: ${Object.values(f.users)
          .map((u) => u.email)
          .join(", ")} (password: see seed-dev.ts)\n` +
        `  tables: ${String(f.tables.length)}, menu items: ${String(f.menu.length)}\n` +
        `  guest QR example (${f.tables[2]?.name ?? ""}): http://localhost:3000/t/${f.tables[2]?.qrToken ?? ""}\n`,
    );
  }
} finally {
  await db.destroy();
}
