/**
 * Online ordering (Standard package): pickup and delivery orders that REUSE the existing order domain.
 *
 * - `orders` / `order_items` / `kitchen_tickets` gain online sources (ONLINE_PICKUP, ONLINE_DELIVERY). Online orders
 *   have no dining session and no table; the database enforces that per source.
 * - `online_orders` (online-orders module) is a 1:1 fulfilment record for such an order: acceptance/fulfilment status,
 *   payment status, the authoritative money and delivery-fee snapshot. Customer PII lives in a separate table.
 * - `payments` can now settle either a dining session or a single (online) order, still at most once.
 * - `menu_items.takeout_tax_rate_id`: reduced-rate (8%) takeout/delivery tax per item (Figma Menu "Dine-in 10% / Takeout 8%").
 * - `entitlement_overrides`: platform-granted feature grants/revocations (read-only for the runtime role).
 *
 * Ownership: online-orders -> online_*, delivery_fee_tiers; entitlements/subscriptions -> entitlement_overrides.
 */
import { type Kysely, sql } from "kysely";
import { roleNames } from "./roles.js";

export async function up(db: Kysely<unknown>): Promise<void> {
  const { app } = roleNames();
  await sql
    .raw(
      `
-- ---------------------------------------------------------------- entitlement overrides
-- Written only by platform operators (no restaurant role can create or change them).
CREATE TABLE app.entitlement_overrides (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL,
  location_id uuid NOT NULL,
  feature_key text NOT NULL CHECK (feature_key ~ '^[a-z][a-z0-9_]{1,60}$'),
  effect      text NOT NULL CHECK (effect IN ('grant', 'revoke')),
  reason      text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  granted_by  text NOT NULL CHECK (char_length(granted_by) BETWEEN 1 AND 200),
  starts_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id),
  CHECK (expires_at IS NULL OR expires_at > starts_at)
);
CREATE INDEX entitlement_overrides_location_idx ON app.entitlement_overrides (location_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- menu: takeout tax rate
ALTER TABLE app.menu_items ADD COLUMN takeout_tax_rate_id uuid;
ALTER TABLE app.menu_items ADD CONSTRAINT menu_items_takeout_tax_fk
  FOREIGN KEY (tenant_id, takeout_tax_rate_id) REFERENCES app.tax_rates (tenant_id, id);

-- ---------------------------------------------------------------- orders: online sources
ALTER TABLE app.orders ALTER COLUMN table_session_id DROP NOT NULL;
ALTER TABLE app.orders DROP CONSTRAINT orders_source_check;
ALTER TABLE app.orders DROP CONSTRAINT orders_check;
ALTER TABLE app.orders ADD CONSTRAINT orders_source_check
  CHECK (source IN ('STAFF_POS', 'TABLE_QR', 'ONLINE_PICKUP', 'ONLINE_DELIVERY'));
ALTER TABLE app.orders ADD CONSTRAINT orders_source_actor_check CHECK (
     (source = 'STAFF_POS' AND created_by_user_id IS NOT NULL AND guest_session_id IS NULL AND table_session_id IS NOT NULL)
  OR (source = 'TABLE_QR' AND guest_session_id IS NOT NULL AND created_by_user_id IS NULL AND table_session_id IS NOT NULL)
  OR (source IN ('ONLINE_PICKUP', 'ONLINE_DELIVERY')
      AND created_by_user_id IS NULL AND guest_session_id IS NULL AND table_session_id IS NULL)
);
ALTER TABLE app.order_items ALTER COLUMN table_session_id DROP NOT NULL;

-- ---------------------------------------------------------------- kitchen: tickets without a table
ALTER TABLE app.kitchen_tickets ALTER COLUMN table_session_id DROP NOT NULL;
ALTER TABLE app.kitchen_tickets ALTER COLUMN table_name DROP NOT NULL;
ALTER TABLE app.kitchen_tickets ADD COLUMN order_no integer;
ALTER TABLE app.kitchen_tickets ADD COLUMN due_at timestamptz;
-- Backfill the order number for existing tickets. FORCE RLS applies to the owner too, so lift it for this statement only.
ALTER TABLE app.kitchen_tickets NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.orders NO FORCE ROW LEVEL SECURITY;
UPDATE app.kitchen_tickets k SET order_no = o.order_no FROM app.orders o WHERE o.id = k.order_id;
ALTER TABLE app.kitchen_tickets FORCE ROW LEVEL SECURITY;
ALTER TABLE app.orders FORCE ROW LEVEL SECURITY;
ALTER TABLE app.kitchen_tickets ALTER COLUMN order_no SET NOT NULL;
ALTER TABLE app.kitchen_tickets DROP CONSTRAINT kitchen_tickets_source_check;
ALTER TABLE app.kitchen_tickets ADD CONSTRAINT kitchen_tickets_source_check
  CHECK (source IN ('STAFF_POS', 'TABLE_QR', 'ONLINE_PICKUP', 'ONLINE_DELIVERY'));
ALTER TABLE app.kitchen_tickets ADD CONSTRAINT kitchen_tickets_table_check CHECK (
     (source IN ('STAFF_POS', 'TABLE_QR') AND table_session_id IS NOT NULL AND table_name IS NOT NULL)
  OR (source IN ('ONLINE_PICKUP', 'ONLINE_DELIVERY') AND table_session_id IS NULL AND table_name IS NULL)
);

-- ---------------------------------------------------------------- payments: settle a session OR one order
ALTER TABLE app.payments ALTER COLUMN table_session_id DROP NOT NULL;
ALTER TABLE app.payments ADD COLUMN order_id uuid;
ALTER TABLE app.payments ADD CONSTRAINT payments_order_fk
  FOREIGN KEY (tenant_id, order_id) REFERENCES app.orders (tenant_id, id);
ALTER TABLE app.payments ADD CONSTRAINT payments_subject_check
  CHECK ((table_session_id IS NULL) <> (order_id IS NULL));
-- Duplicate-payment guard for online orders (the dine-in guard is payments_one_settlement_per_session_uq).
CREATE UNIQUE INDEX payments_one_settlement_per_order_uq ON app.payments (order_id)
  WHERE status = 'completed' AND order_id IS NOT NULL;

-- ---------------------------------------------------------------- online ordering settings (one row per location)
CREATE TABLE app.online_ordering_settings (
  location_id             uuid PRIMARY KEY,
  tenant_id               uuid NOT NULL,
  is_enabled              boolean NOT NULL DEFAULT false,
  is_paused               boolean NOT NULL DEFAULT false,
  pickup_enabled          boolean NOT NULL DEFAULT true,
  delivery_enabled        boolean NOT NULL DEFAULT false,
  pay_at_handover_enabled boolean NOT NULL DEFAULT true,
  pickup_prep_minutes     integer NOT NULL DEFAULT 20 CHECK (pickup_prep_minutes BETWEEN 5 AND 240),
  pickup_slot_minutes     integer NOT NULL DEFAULT 15 CHECK (pickup_slot_minutes BETWEEN 5 AND 120),
  pickup_days_ahead       integer NOT NULL DEFAULT 0 CHECK (pickup_days_ahead BETWEEN 0 AND 6),
  delivery_prep_minutes   integer NOT NULL DEFAULT 40 CHECK (delivery_prep_minutes BETWEEN 10 AND 240),
  min_order_yen           integer NOT NULL DEFAULT 0 CHECK (min_order_yen BETWEEN 0 AND 1000000),
  store_latitude          double precision CHECK (store_latitude BETWEEN -90 AND 90),
  store_longitude         double precision CHECK (store_longitude BETWEEN -180 AND 180),
  checkout_note_ja        text CHECK (char_length(checkout_note_ja) <= 300),
  checkout_note_en        text CHECK (char_length(checkout_note_en) <= 300),
  version                 integer NOT NULL DEFAULT 1,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid REFERENCES app.users(id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id),
  CHECK ((store_latitude IS NULL) = (store_longitude IS NULL))
);

-- Weekly ordering hours in the location's time zone. Several windows per day (lunch/dinner) are allowed;
-- windows never cross midnight (use 24:00 as the end of the day). Overlaps are rejected by the application.
CREATE TABLE app.online_ordering_hours (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL,
  location_id uuid NOT NULL,
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0 = Sunday
  opens_at    time NOT NULL,
  closes_at   time NOT NULL,
  UNIQUE (location_id, weekday, opens_at),
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id),
  CHECK (closes_at > opens_at)
);

-- Distance-based delivery pricing. A tier applies up to max_distance_m (straight-line); the largest tier is the radius.
CREATE TABLE app.delivery_fee_tiers (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL,
  location_id    uuid NOT NULL,
  max_distance_m integer NOT NULL CHECK (max_distance_m BETWEEN 100 AND 50000),
  fee_yen        integer NOT NULL CHECK (fee_yen BETWEEN 0 AND 100000),
  min_order_yen  integer NOT NULL DEFAULT 0 CHECK (min_order_yen BETWEEN 0 AND 1000000),
  UNIQUE (location_id, max_distance_m),
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id)
);

-- Public storefront links. Platform-level lookup table (resolved before tenant context is known), like table_qr_tokens.
CREATE TABLE app.online_store_links (
  token       text PRIMARY KEY CHECK (token ~ '^[A-Za-z0-9_-]{22,64}$'),
  tenant_id   uuid NOT NULL,
  location_id uuid NOT NULL,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id)
);
CREATE UNIQUE INDEX online_store_links_active_uq ON app.online_store_links (location_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- online orders
CREATE TABLE app.online_orders (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  location_id         uuid NOT NULL,
  order_id            uuid NOT NULL UNIQUE,
  order_no            integer NOT NULL,
  fulfillment_type    text NOT NULL CHECK (fulfillment_type IN ('pickup', 'delivery')),
  status              text NOT NULL DEFAULT 'pending_acceptance' CHECK (status IN (
                        'pending_acceptance', 'accepted', 'preparing', 'ready', 'out_for_delivery',
                        'delivered', 'completed', 'rejected', 'cancelled')),
  payment_method      text NOT NULL CHECK (payment_method IN ('pay_on_pickup', 'cash_on_delivery')),
  payment_status      text NOT NULL DEFAULT 'unpaid'
                        CHECK (payment_status IN ('unpaid', 'paid', 'refund_required', 'voided')),
  scheduled_for       timestamptz NOT NULL, -- pickup: chosen slot; delivery: server estimate
  items_subtotal_yen  integer NOT NULL CHECK (items_subtotal_yen >= 0),
  delivery_fee_yen    integer NOT NULL DEFAULT 0 CHECK (delivery_fee_yen >= 0),
  tax_total_yen       integer NOT NULL CHECK (tax_total_yen >= 0),
  total_yen           integer NOT NULL CHECK (total_yen > 0),
  tax_breakdown       jsonb NOT NULL,
  prices_include_tax  boolean NOT NULL,
  delivery_distance_m integer CHECK (delivery_distance_m >= 0),
  rejection_reason    text CHECK (char_length(rejection_reason) BETWEEN 1 AND 200),
  cancellation_reason text CHECK (char_length(cancellation_reason) BETWEEN 1 AND 200),
  cancelled_by        text CHECK (cancelled_by IN ('staff', 'customer')),
  accepted_at         timestamptz,
  ready_at            timestamptz,
  dispatched_at       timestamptz,
  finished_at         timestamptz, -- completed / delivered / rejected / cancelled
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (location_id, order_no),
  FOREIGN KEY (tenant_id, order_id) REFERENCES app.orders (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id),
  -- Each fulfilment type has exactly one payment-recording method in this release.
  CHECK ((fulfillment_type = 'pickup' AND payment_method = 'pay_on_pickup'
          AND delivery_distance_m IS NULL AND delivery_fee_yen = 0)
      OR (fulfillment_type = 'delivery' AND payment_method = 'cash_on_delivery' AND delivery_distance_m IS NOT NULL)),
  CHECK (status NOT IN ('out_for_delivery', 'delivered') OR fulfillment_type = 'delivery'),
  CHECK (status <> 'completed' OR fulfillment_type = 'pickup'),
  -- A pickup is handed over only once paid. Delivery may be delivered unpaid (cash reconciled later): never auto-paid.
  CHECK (status <> 'completed' OR payment_status = 'paid'),
  CHECK ((status = 'rejected') = (rejection_reason IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancellation_reason IS NOT NULL AND cancelled_by IS NOT NULL)),
  -- A rejected/cancelled order never silently keeps money: it is either void or flagged for refund.
  CHECK (status NOT IN ('rejected', 'cancelled') OR payment_status IN ('voided', 'refund_required'))
);
CREATE INDEX online_orders_open_idx ON app.online_orders (location_id, created_at)
  WHERE status NOT IN ('completed', 'delivered', 'rejected', 'cancelled');
CREATE INDEX online_orders_location_time_idx ON app.online_orders (location_id, created_at DESC);

-- Customer personal data, separated from the order so it can be access-restricted and purged on its own.
CREATE TABLE app.online_order_contacts (
  online_order_id       uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL,
  location_id           uuid NOT NULL,
  name                  text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  phone                 text NOT NULL CHECK (phone ~ '^0[0-9]{9,10}$'),
  email                 text CHECK (char_length(email) BETWEEN 3 AND 254),
  postal_code           text CHECK (postal_code ~ '^[0-9]{7}$'),
  prefecture            text CHECK (char_length(prefecture) BETWEEN 1 AND 10),
  city                  text CHECK (char_length(city) BETWEEN 1 AND 60),
  address_line1         text CHECK (char_length(address_line1) BETWEEN 1 AND 120),
  address_line2         text CHECK (char_length(address_line2) BETWEEN 1 AND 120),
  delivery_instructions text CHECK (char_length(delivery_instructions) BETWEEN 1 AND 200),
  latitude              double precision,
  longitude             double precision,
  geocode_precision     text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, online_order_id) REFERENCES app.online_orders (tenant_id, id)
);
CREATE INDEX online_order_contacts_phone_idx ON app.online_order_contacts (location_id, phone);

-- Append-only lifecycle history (who moved the order where, and why).
CREATE TABLE app.online_order_status_history (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL,
  location_id     uuid NOT NULL,
  online_order_id uuid NOT NULL,
  from_status     text,
  to_status       text NOT NULL,
  actor_type      text NOT NULL CHECK (actor_type IN ('staff', 'customer', 'system')),
  actor_id        uuid,
  reason          text CHECK (char_length(reason) <= 200),
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, online_order_id) REFERENCES app.online_orders (tenant_id, id)
);
CREATE INDEX online_order_status_history_order_idx ON app.online_order_status_history (online_order_id, created_at);

-- Customer order-tracking credentials. Platform-level lookup by token hash (only SHA-256 stored), expiring and revocable.
CREATE TABLE app.online_order_tracking_tokens (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  token_hash      bytea NOT NULL UNIQUE,
  tenant_id       uuid NOT NULL,
  location_id     uuid NOT NULL,
  online_order_id uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  FOREIGN KEY (tenant_id, online_order_id) REFERENCES app.online_orders (tenant_id, id)
);
CREATE INDEX online_order_tracking_tokens_order_idx ON app.online_order_tracking_tokens (online_order_id)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- row-level security
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['entitlement_overrides', 'online_ordering_settings', 'online_ordering_hours',
                           'delivery_fee_tiers', 'online_orders', 'online_order_contacts',
                           'online_order_status_history']
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON app.%I USING (tenant_id = app.current_tenant_id())
                    WITH CHECK (tenant_id = app.current_tenant_id())', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------- privileges beyond defaults
REVOKE INSERT, UPDATE, DELETE ON app.entitlement_overrides FROM ${app};
REVOKE DELETE ON app.online_orders, app.online_order_contacts, app.online_ordering_settings FROM ${app};
REVOKE UPDATE, DELETE ON app.online_order_status_history FROM ${app};
REVOKE DELETE ON app.online_store_links, app.online_order_tracking_tokens FROM ${app};
`,
    )
    .execute(db);
}

export function down(): Promise<void> {
  return Promise.reject(
    new Error("Forward-only migrations: restore from backup or write a new migration."),
  );
}
