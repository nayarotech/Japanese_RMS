import { Kysely, PostgresDialect } from "kysely";
import { type Migration, type MigrationProvider, Migrator } from "kysely/migration";
import pg from "pg";
import * as foundation from "./migrations/2026112001_foundation.js";
import * as dineIn from "./migrations/2026112002_dine_in.js";
import * as onlineOrdering from "./migrations/2026112003_online_ordering.js";
import * as menuItemImages from "./migrations/2026112401_menu_item_images.js";
import * as storefront from "./migrations/2026112701_storefront.js";
import * as floorPickup from "./migrations/2026112801_floor_pickup.js";
import * as kitchenImmediate from "./migrations/2026112901_kitchen_immediate_preparing.js";

/** Static provider: migrations are bundled with the build (no filesystem scanning at runtime). */
class StaticMigrationProvider implements MigrationProvider {
  getMigrations(): Promise<Record<string, Migration>> {
    return Promise.resolve({
      "2026112001_foundation": foundation,
      "2026112002_dine_in": dineIn,
      "2026112003_online_ordering": onlineOrdering,
      "2026112401_menu_item_images": menuItemImages,
      "2026112701_storefront": storefront,
      "2026112801_floor_pickup": floorPickup,
      "2026112901_kitchen_immediate_preparing": kitchenImmediate,
    });
  }
}

export interface MigratorConnection {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
}

/** Runs pending migrations as the MIGRATOR role. Never call this from the running API or worker. */
export async function migrateToLatest(conn: MigratorConnection): Promise<string[]> {
  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ ...conn, max: 1, ssl: conn.ssl ? { rejectUnauthorized: true } : false }),
    }),
  });
  try {
    const migrator = new Migrator({
      db,
      provider: new StaticMigrationProvider(),
      migrationTableSchema: "app",
    });
    const { error, results } = await migrator.migrateToLatest();
    const failed = results?.find((r) => r.status === "Error");
    if (error || failed) {
      throw new Error(
        `Migration failed${failed ? ` at ${failed.migrationName}` : ""}: ${String(error)}`,
      );
    }
    return (results ?? []).map((r) => r.migrationName);
  } finally {
    await db.destroy();
  }
}
