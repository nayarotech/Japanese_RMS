/**
 * PostgreSQL access. One bounded pool per process; tenant-scoped work ONLY through withTenantTransaction.
 * See docs/architecture/03-tenant-isolation.md.
 */
import type { AppConfig } from "@restaurant-platform/config";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import pg from "pg";
import type { Database } from "./schema.js";

export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;

export interface DbCredentials {
  user: string;
  password: string;
  max: number;
}

export function createPool(config: AppConfig, creds: DbCredentials): pg.Pool {
  return new pg.Pool({
    host: config.POSTGRES_HOST,
    port: config.POSTGRES_PORT,
    database: config.POSTGRES_DB,
    user: creds.user,
    password: creds.password,
    max: creds.max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS,
    application_name: `restaurant-platform:${config.INSTANCE_NAME}`,
    ssl:
      config.DATABASE_SSL_MODE === "disable"
        ? false
        : { rejectUnauthorized: config.DATABASE_SSL_MODE === "verify-full" },
  });
}

export function createDb(pool: pg.Pool): Db {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

export interface TenantScope {
  tenantId: string;
  /** Optional: used only by the memberships policy during login. */
  userId?: string | null;
}

/**
 * Runs `fn` in a transaction whose tenant context is set transaction-locally (`set_config(..., true)`),
 * so pooled connections can never leak tenant context. RLS policies fail closed without it.
 */
export async function withTenantTransaction<T>(
  db: Db,
  scope: TenantScope,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (tx) => {
    await sql`SELECT set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.user_id', ${scope.userId ?? ""}, true)`.execute(
      tx,
    );
    return fn(tx);
  });
}

/** Transaction with only a user context (login: discover memberships for this user, no tenant yet). */
export async function withUserTransaction<T>(
  db: Db,
  userId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (tx) => {
    await sql`SELECT set_config('app.user_id', ${userId}, true)`.execute(tx);
    return fn(tx);
  });
}

/** Increments and returns a per-location counter (slip, order, receipt numbers). Row-locked, gap-free per tx. */
export async function nextCounter(
  tx: Tx,
  tenantId: string,
  locationId: string,
  counter: "slip" | "order" | "receipt",
): Promise<number> {
  const row = await tx
    .insertInto("location_counters")
    .values({ tenant_id: tenantId, location_id: locationId, counter, value: 1 })
    .onConflict((oc) =>
      oc
        .columns(["location_id", "counter"])
        .doUpdateSet({ value: sql`location_counters.value + 1` }),
    )
    .returning("value")
    .executeTakeFirstOrThrow();
  return Number(row.value);
}
