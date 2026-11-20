/** Creates a fresh test database (least-privilege roles, RLS, migrations) before the suite. */
import { recreateDatabase } from "../src/infrastructure/database/bootstrap.js";

export default async function setup(): Promise<void> {
  const e = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`${k} is required for integration tests`);
    return v;
  };
  const base = process.env["POSTGRES_DB"] ?? "restaurant_platform";
  const database = base.endsWith("_test") ? base : `${base}_test`;
  await recreateDatabase({
    host: e("POSTGRES_HOST"),
    port: Number(process.env["POSTGRES_PORT"] ?? 5432),
    database,
    superuser: { user: e("POSTGRES_SUPERUSER"), password: e("POSTGRES_SUPERUSER_PASSWORD") },
    migrator: { user: e("DATABASE_MIGRATOR_USER"), password: e("DATABASE_MIGRATOR_PASSWORD") },
    rolePasswords: { app: e("DATABASE_APP_PASSWORD"), relay: e("DATABASE_RELAY_PASSWORD") },
  });
}
