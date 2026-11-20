/**
 * Foundation schema: tenancy, identity, branding, plans/subscriptions, audit, outbox, idempotency, counters.
 * Runs as the MIGRATOR role (schema owner). See docs/architecture/07-database-principles.md.
 */
import { type Kysely, sql } from "kysely";
import { roleNames } from "./roles.js";

export async function up(db: Kysely<unknown>): Promise<void> {
  const { app, relay } = roleNames();
  await sql
    .raw(
      `
-- Tenant context helpers. NULLIF guards against '' after a transaction-local setting resets.
CREATE FUNCTION app.current_tenant_id() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;
CREATE FUNCTION app.current_user_id() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

-- ---------------------------------------------------------------- platform tables (no tenant RLS)
CREATE TABLE app.brands (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  display_name  text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  short_mark    text NOT NULL CHECK (char_length(short_mark) BETWEEN 1 AND 2),
  primary_color text NOT NULL CHECK (primary_color ~ '^#[0-9a-fA-F]{6}$'),
  support_email text,
  support_phone text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.brand_domains (
  host     text PRIMARY KEY CHECK (host = lower(host)),
  brand_id uuid NOT NULL REFERENCES app.brands(id)
);

CREATE TABLE app.users (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  email              text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
  password_hash      text NOT NULL,
  display_name       text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_uq ON app.users (lower(email));

CREATE TABLE app.plans (
  id   uuid PRIMARY KEY DEFAULT uuidv7(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_]{2,40}$'),
  name text NOT NULL
);
CREATE TABLE app.plan_versions (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  plan_id      uuid NOT NULL REFERENCES app.plans(id),
  version      integer NOT NULL CHECK (version > 0),
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, version)
);
CREATE TABLE app.plan_version_features (
  plan_version_id uuid NOT NULL REFERENCES app.plan_versions(id),
  feature_key     text NOT NULL CHECK (feature_key ~ '^[a-z][a-z0-9_]{1,60}$'),
  PRIMARY KEY (plan_version_id, feature_key)
);

-- ---------------------------------------------------------------- tenant tables
CREATE TABLE app.tenants (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  brand_id   uuid NOT NULL REFERENCES app.brands(id),
  name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.locations (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL REFERENCES app.tenants(id),
  name                text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  time_zone           text NOT NULL DEFAULT 'Asia/Tokyo',
  business_day_cutoff time NOT NULL DEFAULT '04:00',
  prices_include_tax  boolean NOT NULL DEFAULT true,
  tax_rounding        text NOT NULL DEFAULT 'floor' CHECK (tax_rounding IN ('floor', 'round', 'ceil')),
  qr_ordering_enabled boolean NOT NULL DEFAULT true,
  receipt_header      text CHECK (char_length(receipt_header) <= 500),
  receipt_footer      text CHECK (char_length(receipt_footer) <= 500),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE app.tax_rates (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL,
  location_id uuid NOT NULL,
  code        text NOT NULL CHECK (code ~ '^[a-z0-9_]{2,30}$'),
  rate_bp     integer NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000), -- basis points: 1000 = 10%
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (location_id, code),
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id)
);

CREATE TABLE app.location_memberships (
  tenant_id   uuid NOT NULL,
  location_id uuid NOT NULL,
  user_id     uuid NOT NULL REFERENCES app.users(id),
  role        text NOT NULL CHECK (role IN ('owner', 'manager', 'cashier', 'waiter', 'kitchen')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, user_id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id)
);
CREATE INDEX location_memberships_user_idx ON app.location_memberships (user_id);

-- Staff sessions: platform table, looked up by token hash before tenant context exists.
-- Only SHA-256 hashes of session tokens are stored.
CREATE TABLE app.staff_sessions (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  token_hash          bytea NOT NULL UNIQUE,
  user_id             uuid NOT NULL REFERENCES app.users(id),
  tenant_id           uuid NOT NULL REFERENCES app.tenants(id),
  location_id         uuid NOT NULL REFERENCES app.locations(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  idle_expires_at     timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at          timestamptz,
  ip                  inet,
  user_agent          text CHECK (char_length(user_agent) <= 300)
);
CREATE INDEX staff_sessions_user_idx ON app.staff_sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE app.subscriptions (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL,
  location_id     uuid NOT NULL,
  plan_version_id uuid NOT NULL REFERENCES app.plan_versions(id),
  status          text NOT NULL CHECK (status IN ('trial', 'active', 'past_due', 'suspended', 'cancelled', 'expired')),
  starts_at       timestamptz NOT NULL DEFAULT now(),
  ends_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id)
);
-- One current subscription per location.
CREATE UNIQUE INDEX subscriptions_current_uq ON app.subscriptions (location_id)
  WHERE status IN ('trial', 'active', 'past_due', 'suspended');

CREATE TABLE app.location_counters (
  tenant_id   uuid NOT NULL,
  location_id uuid NOT NULL,
  counter     text NOT NULL CHECK (counter IN ('slip', 'order', 'receipt')),
  value       bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (location_id, counter),
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id)
);

CREATE TABLE app.idempotency_records (
  tenant_id       uuid NOT NULL REFERENCES app.tenants(id),
  scope           text NOT NULL,
  key             text NOT NULL CHECK (char_length(key) BETWEEN 8 AND 100),
  request_hash    text NOT NULL,
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope, key)
);

-- Append-only audit trail.
CREATE TABLE app.audit_events (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES app.tenants(id),
  location_id uuid,
  actor_type  text NOT NULL CHECK (actor_type IN ('staff', 'guest', 'system')),
  actor_id    uuid,
  action      text NOT NULL,
  target_type text,
  target_id   uuid,
  metadata    jsonb NOT NULL DEFAULT '{}',
  request_id  text,
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_tenant_time_idx ON app.audit_events (tenant_id, created_at DESC);

-- Transactional outbox. Written in the same transaction as the business change; relayed by the worker.
CREATE TABLE app.outbox_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES app.tenants(id),
  location_id  uuid,
  event_type   text NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text
);
CREATE INDEX outbox_events_pending_idx ON app.outbox_events (id) WHERE processed_at IS NULL;

CREATE FUNCTION app.notify_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('outbox_events', '');
  RETURN NULL;
END $$;
CREATE TRIGGER outbox_events_notify AFTER INSERT ON app.outbox_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.notify_outbox();

-- ---------------------------------------------------------------- row-level security
ALTER TABLE app.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.tenants
  USING (id = app.current_tenant_id()) WITH CHECK (id = app.current_tenant_id());

-- Memberships are also readable for the current user (needed at login to discover their locations).
ALTER TABLE app.location_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.location_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.location_memberships
  USING (tenant_id = app.current_tenant_id() OR user_id = app.current_user_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['locations', 'tax_rates', 'subscriptions', 'location_counters',
                           'idempotency_records', 'audit_events']
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON app.%I USING (tenant_id = app.current_tenant_id())
                    WITH CHECK (tenant_id = app.current_tenant_id())', t);
  END LOOP;
END $$;

-- Outbox: the app may only INSERT for its own tenant; the relay role may read/mark all rows.
ALTER TABLE app.outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.outbox_events FORCE ROW LEVEL SECURITY;
CREATE POLICY app_insert ON app.outbox_events FOR INSERT TO ${app}
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY relay_all ON app.outbox_events FOR ALL TO ${relay} USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------- privileges beyond defaults
REVOKE UPDATE, DELETE ON app.audit_events FROM ${app};
REVOKE SELECT, UPDATE, DELETE ON app.outbox_events FROM ${app};
GRANT SELECT, UPDATE ON app.outbox_events TO ${relay};
REVOKE INSERT, UPDATE, DELETE ON app.plans, app.plan_versions, app.plan_version_features FROM ${app};
REVOKE INSERT, UPDATE, DELETE ON app.brands, app.brand_domains FROM ${app};
-- Migration bookkeeping tables are created by the migrator before this runs; the app must not touch them.
REVOKE ALL ON app.kysely_migration, app.kysely_migration_lock FROM ${app};
`,
    )
    .execute(db);
}

export function down(): Promise<void> {
  return Promise.reject(
    new Error("Forward-only migrations: restore from backup or write a new migration."),
  );
}
