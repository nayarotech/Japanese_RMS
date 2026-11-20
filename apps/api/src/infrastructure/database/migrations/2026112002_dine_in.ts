/**
 * Dine-in workflow schema: tables, table sessions, QR tokens, guest sessions, menu, orders,
 * kitchen tickets, payments and receipts.
 *
 * Ownership (modules/README.md): tables -> restaurant_tables, table_sessions, table_qr_tokens;
 * qr-ordering -> guest_sessions; menus -> menu_*; orders -> orders, order_items;
 * kitchen -> kitchen_tickets, kitchen_ticket_items; payments -> payments, receipts.
 */
import { type Kysely, sql } from "kysely";
import { roleNames } from "./roles.js";

export async function up(db: Kysely<unknown>): Promise<void> {
  const { app } = roleNames();
  await sql
    .raw(
      `
-- ---------------------------------------------------------------- tables
CREATE TABLE app.restaurant_tables (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL,
  location_id uuid NOT NULL,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 20),
  area        text CHECK (char_length(area) <= 40),
  capacity    integer NOT NULL CHECK (capacity BETWEEN 1 AND 50),
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (location_id, name),
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id)
);

-- Printed QR tokens. Platform-level lookup table (resolved before tenant context is known).
-- Possession of a token only allows viewing the menu; ordering needs a joined guest session.
CREATE TABLE app.table_qr_tokens (
  token       text PRIMARY KEY CHECK (token ~ '^[A-Za-z0-9_-]{22,64}$'),
  tenant_id   uuid NOT NULL,
  location_id uuid NOT NULL,
  table_id    uuid NOT NULL,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  FOREIGN KEY (tenant_id, table_id) REFERENCES app.restaurant_tables (tenant_id, id)
);
CREATE UNIQUE INDEX table_qr_tokens_active_uq ON app.table_qr_tokens (table_id) WHERE revoked_at IS NULL;

CREATE TABLE app.table_sessions (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id            uuid NOT NULL,
  location_id          uuid NOT NULL,
  table_id             uuid NOT NULL,
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'bill_requested', 'closed')),
  guest_count          integer NOT NULL CHECK (guest_count BETWEEN 1 AND 99),
  slip_no              integer NOT NULL,
  assigned_waiter_id   uuid REFERENCES app.users(id),
  opened_by            uuid REFERENCES app.users(id), -- NULL = opened by a guest QR scan
  opened_at            timestamptz NOT NULL DEFAULT now(),
  bill_requested_at    timestamptz,
  closed_at            timestamptz,
  closed_by            uuid REFERENCES app.users(id),
  version              integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, table_id) REFERENCES app.restaurant_tables (tenant_id, id),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
-- The invariant that makes "occupied" trustworthy: at most one non-closed session per table.
CREATE UNIQUE INDEX table_sessions_one_active_per_table_uq ON app.table_sessions (table_id)
  WHERE status <> 'closed';
CREATE INDEX table_sessions_active_by_location_idx ON app.table_sessions (location_id)
  WHERE status <> 'closed';

-- Guest (customer) ordering sessions, issued when a guest scans the QR of a SEATED table.
-- Platform-level lookup by token hash; bound to ONE table session and revoked when it closes.
CREATE TABLE app.guest_sessions (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  token_hash       bytea NOT NULL UNIQUE,
  tenant_id        uuid NOT NULL,
  location_id      uuid NOT NULL,
  table_session_id uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  ip               inet,
  FOREIGN KEY (tenant_id, table_session_id) REFERENCES app.table_sessions (tenant_id, id)
);
CREATE INDEX guest_sessions_table_session_idx ON app.guest_sessions (table_session_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- menu
CREATE TABLE app.menu_categories (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL,
  location_id uuid NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id)
);
CREATE TABLE app.menu_category_translations (
  tenant_id   uuid NOT NULL,
  category_id uuid NOT NULL,
  locale      text NOT NULL CHECK (locale IN ('ja', 'en')),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  PRIMARY KEY (category_id, locale),
  FOREIGN KEY (tenant_id, category_id) REFERENCES app.menu_categories (tenant_id, id)
);

CREATE TABLE app.menu_items (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL,
  location_id  uuid NOT NULL,
  category_id  uuid NOT NULL,
  code         text CHECK (char_length(code) <= 20),
  price_yen    integer NOT NULL CHECK (price_yen BETWEEN 0 AND 10000000),
  tax_rate_id  uuid NOT NULL,
  is_available boolean NOT NULL DEFAULT true,
  is_active    boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 0,
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES app.menu_categories (tenant_id, id),
  FOREIGN KEY (tenant_id, tax_rate_id) REFERENCES app.tax_rates (tenant_id, id)
);
CREATE INDEX menu_items_location_idx ON app.menu_items (location_id, category_id, sort_order) WHERE is_active;

CREATE TABLE app.menu_item_translations (
  tenant_id    uuid NOT NULL,
  menu_item_id uuid NOT NULL,
  locale       text NOT NULL CHECK (locale IN ('ja', 'en')),
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  description  text CHECK (char_length(description) <= 300),
  PRIMARY KEY (menu_item_id, locale),
  FOREIGN KEY (tenant_id, menu_item_id) REFERENCES app.menu_items (tenant_id, id)
);

-- ---------------------------------------------------------------- orders
CREATE TABLE app.orders (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id          uuid NOT NULL,
  location_id        uuid NOT NULL,
  table_session_id   uuid NOT NULL,
  order_no           integer NOT NULL,
  source             text NOT NULL CHECK (source IN ('STAFF_POS', 'TABLE_QR')),
  created_by_user_id uuid REFERENCES app.users(id),
  guest_session_id   uuid REFERENCES app.guest_sessions(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (location_id, order_no),
  FOREIGN KEY (tenant_id, table_session_id) REFERENCES app.table_sessions (tenant_id, id),
  CHECK ((source = 'STAFF_POS' AND created_by_user_id IS NOT NULL AND guest_session_id IS NULL)
      OR (source = 'TABLE_QR' AND guest_session_id IS NOT NULL AND created_by_user_id IS NULL))
);
CREATE INDEX orders_table_session_idx ON app.orders (table_session_id, created_at);

-- One row per submitted line. Lines are never merged: two identical dishes with different notes stay distinct.
CREATE TABLE app.order_items (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  location_id      uuid NOT NULL,
  order_id         uuid NOT NULL,
  table_session_id uuid NOT NULL,
  menu_item_id     uuid NOT NULL,
  name_ja          text NOT NULL,
  name_en          text,
  unit_price_yen   integer NOT NULL CHECK (unit_price_yen >= 0),
  quantity         integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  line_total_yen   integer GENERATED ALWAYS AS (unit_price_yen * quantity) STORED,
  tax_rate_bp      integer NOT NULL CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  note             text CHECK (char_length(note) BETWEEN 1 AND 140),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
  voided_at        timestamptz,
  voided_by        uuid REFERENCES app.users(id),
  void_reason      text CHECK (char_length(void_reason) <= 200),
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES app.orders (tenant_id, id),
  FOREIGN KEY (tenant_id, table_session_id) REFERENCES app.table_sessions (tenant_id, id),
  FOREIGN KEY (tenant_id, menu_item_id) REFERENCES app.menu_items (tenant_id, id),
  CHECK ((status = 'voided') = (voided_at IS NOT NULL))
);
CREATE INDEX order_items_order_idx ON app.order_items (order_id);
CREATE INDEX order_items_session_idx ON app.order_items (table_session_id) WHERE status = 'active';

-- ---------------------------------------------------------------- kitchen
CREATE TABLE app.kitchen_tickets (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  location_id      uuid NOT NULL,
  order_id         uuid NOT NULL,
  table_session_id uuid NOT NULL,
  table_name       text NOT NULL,
  source           text NOT NULL CHECK (source IN ('STAFF_POS', 'TABLE_QR')),
  status           text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'preparing', 'ready', 'served', 'voided')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (order_id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES app.orders (tenant_id, id),
  FOREIGN KEY (tenant_id, table_session_id) REFERENCES app.table_sessions (tenant_id, id)
);
CREATE INDEX kitchen_tickets_open_idx ON app.kitchen_tickets (location_id, status, created_at)
  WHERE status IN ('new', 'preparing', 'ready');

-- Item-level preparation/serving status (supports partial readiness).
CREATE TABLE app.kitchen_ticket_items (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL,
  location_id   uuid NOT NULL,
  ticket_id     uuid NOT NULL,
  order_item_id uuid NOT NULL UNIQUE,
  name_ja       text NOT NULL,
  name_en       text,
  quantity      integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  note          text CHECK (char_length(note) BETWEEN 1 AND 140),
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'preparing', 'ready', 'served', 'voided')),
  started_at    timestamptz,
  ready_at      timestamptz,
  served_at     timestamptz,
  served_by     uuid REFERENCES app.users(id),
  version       integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES app.kitchen_tickets (tenant_id, id),
  FOREIGN KEY (tenant_id, order_item_id) REFERENCES app.order_items (tenant_id, id)
);
CREATE INDEX kitchen_ticket_items_ticket_idx ON app.kitchen_ticket_items (ticket_id);
CREATE INDEX kitchen_ticket_items_ready_idx ON app.kitchen_ticket_items (location_id) WHERE status = 'ready';

-- ---------------------------------------------------------------- payments & receipts
CREATE TABLE app.payments (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  location_id         uuid NOT NULL,
  table_session_id    uuid NOT NULL,
  method              text NOT NULL CHECK (method IN ('cash')),
  status              text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed')),
  amount_due_yen      integer NOT NULL CHECK (amount_due_yen > 0),
  amount_received_yen integer NOT NULL CHECK (amount_received_yen >= amount_due_yen),
  change_yen          integer NOT NULL CHECK (change_yen = amount_received_yen - amount_due_yen),
  received_by         uuid NOT NULL REFERENCES app.users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, table_session_id) REFERENCES app.table_sessions (tenant_id, id)
);
-- No split billing in this release: a table session is settled exactly once.
CREATE UNIQUE INDEX payments_one_settlement_per_session_uq ON app.payments (table_session_id)
  WHERE status = 'completed';
CREATE INDEX payments_location_time_idx ON app.payments (location_id, created_at DESC);

CREATE TABLE app.receipts (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  location_id      uuid NOT NULL,
  payment_id       uuid NOT NULL UNIQUE,
  table_session_id uuid NOT NULL,
  receipt_no       integer NOT NULL,
  issued_at        timestamptz NOT NULL DEFAULT now(),
  body             jsonb NOT NULL,
  UNIQUE (location_id, receipt_no),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES app.payments (tenant_id, id)
);

-- ---------------------------------------------------------------- row-level security
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['restaurant_tables', 'table_sessions', 'menu_categories', 'menu_category_translations',
                           'menu_items', 'menu_item_translations', 'orders', 'order_items', 'kitchen_tickets',
                           'kitchen_ticket_items', 'payments', 'receipts']
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON app.%I USING (tenant_id = app.current_tenant_id())
                    WITH CHECK (tenant_id = app.current_tenant_id())', t);
  END LOOP;
END $$;

-- Financial records are immutable for the runtime role.
REVOKE UPDATE, DELETE ON app.payments, app.receipts FROM ${app};
REVOKE DELETE ON app.orders, app.order_items, app.kitchen_tickets, app.kitchen_ticket_items, app.table_sessions FROM ${app};
`,
    )
    .execute(db);
}

export function down(): Promise<void> {
  return Promise.reject(
    new Error("Forward-only migrations: restore from backup or write a new migration."),
  );
}
