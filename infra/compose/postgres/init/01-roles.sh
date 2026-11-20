#!/bin/sh
# LOCAL DEVELOPMENT ONLY. Runs once when the postgres volume is first created.
# Creates the least-privilege role layout described in docs/architecture/07-database-principles.md.
# It creates roles, a schema and grants only. NO tables (tables come from migrations).
# Staging/production roles are provisioned through infrastructure tooling, not this script.
set -eu

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v db="$POSTGRES_DB" \
  -v migrator="$DATABASE_MIGRATOR_USER" -v migrator_pw="$DATABASE_MIGRATOR_PASSWORD" \
  -v app="$DATABASE_APP_USER" -v app_pw="$DATABASE_APP_PASSWORD" \
  -v relay="$DATABASE_RELAY_USER" -v relay_pw="$DATABASE_RELAY_PASSWORD" <<'EOSQL'
-- Schema owner: runs migrations. Never used by the running api or worker.
CREATE ROLE :"migrator" LOGIN PASSWORD :'migrator_pw'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

-- Runtime role: DML only, subject to Row-Level Security, not the table owner.
CREATE ROLE :"app" LOGIN PASSWORD :'app_pw'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;

-- Outbox relay role (worker): may only read/mark outbox rows across tenants. Grants come from migrations.
CREATE ROLE :"relay" LOGIN PASSWORD :'relay_pw'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;

REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO :"migrator", :"app", :"relay";

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA app AUTHORIZATION :"migrator";
GRANT USAGE ON SCHEMA app TO :"app", :"relay";

-- Tables created later by the migrator are usable (not alterable) by the app role.
-- Append-only tables (e.g. audit) REVOKE UPDATE, DELETE explicitly in their migration.
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator" IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator" IN SCHEMA app
  GRANT USAGE, SELECT ON SEQUENCES TO :"app";

ALTER ROLE :"migrator" SET search_path = app;
ALTER ROLE :"app" SET search_path = app;
ALTER ROLE :"relay" SET search_path = app;
-- Defence in depth: bound runaway queries and abandoned transactions for the runtime role.
ALTER ROLE :"app" SET statement_timeout = '5s';
ALTER ROLE :"app" SET idle_in_transaction_session_timeout = '10s';
EOSQL
