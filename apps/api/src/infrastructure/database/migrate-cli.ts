/** One-off migration task: `pnpm --filter @restaurant-platform/api db:migrate`. Uses the migrator credential. */
import { migrateToLatest } from "./migrator.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const applied = await migrateToLatest({
  host: required("POSTGRES_HOST"),
  port: Number(process.env["POSTGRES_PORT"] ?? 5432),
  database: required("POSTGRES_DB"),
  user: required("DATABASE_MIGRATOR_USER"),
  password: required("DATABASE_MIGRATOR_PASSWORD"),
  ssl: (process.env["DATABASE_SSL_MODE"] ?? "disable") !== "disable",
});
process.stdout.write(
  applied.length ? `Applied: ${applied.join(", ")}\n` : "Database is up to date.\n",
);
