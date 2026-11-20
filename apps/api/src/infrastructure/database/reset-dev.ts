/** `pnpm --filter @restaurant-platform/api db:reset`: drop + recreate + migrate the LOCAL database. */
import { recreateDatabase } from "./bootstrap.js";

const env = process.env["APP_ENV"] ?? "development";
if (env !== "development") throw new Error(`Refusing to reset the database in APP_ENV=${env}`);
const e = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};
await recreateDatabase({
  host: e("POSTGRES_HOST"),
  port: Number(process.env["POSTGRES_PORT"] ?? 5432),
  database: e("POSTGRES_DB"),
  superuser: { user: e("POSTGRES_SUPERUSER"), password: e("POSTGRES_SUPERUSER_PASSWORD") },
  migrator: { user: e("DATABASE_MIGRATOR_USER"), password: e("DATABASE_MIGRATOR_PASSWORD") },
  rolePasswords: { app: e("DATABASE_APP_PASSWORD"), relay: e("DATABASE_RELAY_PASSWORD") },
});
process.stdout.write("Local database recreated and migrated. Run db:seed for demo data.\n");
