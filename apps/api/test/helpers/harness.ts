/**
 * Integration-test harness: real PostgreSQL (runtime role, RLS enforced), real Redis, real Express app.
 * The migrator connection is used ONLY to create fixtures (as production onboarding tooling would).
 */
import { randomUUID } from "node:crypto";
import { loadConfig } from "@restaurant-platform/config";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { createApp } from "../../src/app.js";
import type { AppDeps } from "../../src/app/deps.js";
import {
  type Tx,
  createDb,
  createPool,
  withTenantTransaction,
} from "../../src/infrastructure/database/db.js";
import {
  createTenantFixture,
  type TenantFixture,
} from "../../src/infrastructure/database/fixtures.js";
import type { Database } from "../../src/infrastructure/database/schema.js";
import { createLogger } from "../../src/infrastructure/logging/logger.js";
import { createRedis } from "../../src/infrastructure/redis/redis.js";
import { type Geocoder, createStaticDemoGeocoder } from "../../src/modules/integrations/index.js";
import {
  DEFAULT_RATE_LIMITS,
  type RateLimitConfig,
  createRateLimiters,
} from "../../src/infrastructure/security/rate-limit.js";

export const TEST_PASSWORD = "test-password-not-secret-1";
export const ORIGIN = "http://localhost:3000";

const GENEROUS: RateLimitConfig = Object.fromEntries(
  Object.keys(DEFAULT_RATE_LIMITS).map((k) => [k, { points: 10_000, durationSeconds: 60 }]),
) as unknown as RateLimitConfig;

export interface Harness {
  /** Runs a query in a tenant context as the RUNTIME role (RLS applies). */
  asTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  deps: AppDeps;
  app: ReturnType<typeof createApp>;
  migratorDb: Kysely<Database>;
  relayDb: Kysely<Database>;
  fixture(overrides?: Partial<Parameters<typeof createTenantFixture>[1]>): Promise<TenantFixture>;
  close(): Promise<void>;
}

export function migratorDbFor(config: ReturnType<typeof loadConfig>): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        host: config.POSTGRES_HOST,
        port: config.POSTGRES_PORT,
        database: config.POSTGRES_DB,
        user: process.env["DATABASE_MIGRATOR_USER"],
        password: process.env["DATABASE_MIGRATOR_PASSWORD"],
        max: 2,
      }),
    }),
  });
}

export function createHarness(
  opts: { limits?: Partial<RateLimitConfig>; geocoder?: Geocoder } = {},
): Promise<Harness> {
  const config = loadConfig(process.env);
  const db = createDb(
    createPool(config, {
      user: config.DATABASE_APP_USER,
      password: config.DATABASE_APP_PASSWORD,
      max: 10,
    }),
  );
  const relayDb = createDb(
    createPool(config, {
      user: config.DATABASE_RELAY_USER,
      password: config.DATABASE_RELAY_PASSWORD ?? "",
      max: 2,
    }),
  );
  const redis = createRedis(config, "test");
  const limits = createRateLimiters(
    redis,
    { ...GENEROUS, ...opts.limits },
    `rl-test-${randomUUID()}`,
  );
  const deps: AppDeps = {
    config,
    db,
    redis,
    logger: createLogger(config, "test"),
    limits,
    geocoder: opts.geocoder ?? createStaticDemoGeocoder(),
  };
  const migratorDb = migratorDbFor(config);
  return Promise.resolve({
    deps,
    asTenant: (tenantId, fn) => withTenantTransaction(db, { tenantId }, fn),
    app: createApp(deps),
    migratorDb,
    relayDb,
    fixture: (overrides) =>
      createTenantFixture(migratorDb, {
        slug: randomUUID().slice(0, 8),
        password: TEST_PASSWORD,
        ...overrides,
      }),
    close: async () => {
      await Promise.allSettled([
        db.destroy(),
        relayDb.destroy(),
        migratorDb.destroy(),
        redis.quit(),
      ]);
    },
  });
}
