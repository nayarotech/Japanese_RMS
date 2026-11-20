/**
 * Recreates a database with the least-privilege layout (LOCAL DEVELOPMENT AND TESTS ONLY).
 * Mirrors infra/compose/postgres/init/01-roles.sh, then applies migrations as the migrator.
 * Requires superuser credentials, which never exist in staging/production application config.
 */
import pg from "pg";
import { roleNames } from "./migrations/roles.js";
import { migrateToLatest } from "./migrator.js";

export interface BootstrapOptions {
  host: string;
  port: number;
  database: string;
  superuser: { user: string; password: string };
  migrator: { user: string; password: string };
  /** Passwords used only if the runtime roles do not exist yet (fresh CI database). */
  rolePasswords?: { app: string; relay: string };
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

export async function recreateDatabase(opts: BootstrapOptions): Promise<void> {
  const { app, relay } = roleNames();
  for (const id of [opts.database, opts.migrator.user, app, relay]) {
    if (!IDENT.test(id)) throw new Error(`Unsafe identifier: ${id}`);
  }
  const admin = new pg.Client({
    host: opts.host,
    port: opts.port,
    database: "postgres",
    ...opts.superuser,
  });
  await admin.connect();
  try {
    // Fresh environments (CI): create the least-privilege roles if missing. Passwords are bound as literals safely.
    const roles: [string, string][] = [
      [opts.migrator.user, opts.migrator.password],
      [app, opts.rolePasswords?.app ?? ""],
      [relay, opts.rolePasswords?.relay ?? ""],
    ];
    for (const [name, password] of roles) {
      const exists = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name]);
      if (exists.rowCount === 0) {
        if (!password)
          throw new Error(`Role ${name} does not exist and no password was provided to create it`);
        const literal =
          (await admin.query<{ q: string }>("SELECT quote_literal($1) AS q", [password])).rows[0]
            ?.q ?? "''";
        await admin.query(
          `CREATE ROLE ${name} LOGIN PASSWORD ${literal} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT`,
        );
        await admin.query(`ALTER ROLE ${name} SET search_path = app`);
      }
    }
    await admin.query(`DROP DATABASE IF EXISTS ${opts.database} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${opts.database}`);
  } finally {
    await admin.end();
  }
  const dbAdmin = new pg.Client({
    host: opts.host,
    port: opts.port,
    database: opts.database,
    ...opts.superuser,
  });
  await dbAdmin.connect();
  try {
    await dbAdmin.query(`
      REVOKE ALL ON DATABASE ${opts.database} FROM PUBLIC;
      GRANT CONNECT ON DATABASE ${opts.database} TO ${opts.migrator.user}, ${app}, ${relay};
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      CREATE SCHEMA app AUTHORIZATION ${opts.migrator.user};
      GRANT USAGE ON SCHEMA app TO ${app}, ${relay};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${opts.migrator.user} IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${app};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${opts.migrator.user} IN SCHEMA app GRANT USAGE, SELECT ON SEQUENCES TO ${app};
    `);
  } finally {
    await dbAdmin.end();
  }
  await migrateToLatest({
    host: opts.host,
    port: opts.port,
    database: opts.database,
    ...opts.migrator,
  });
}
