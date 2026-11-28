/**
 * Restaurant storefront (customer-facing presentation of a branch): the restaurant-level customization that the
 * white-label brand model allows (docs/architecture/05-white-label-branding.md). Never the partner brand itself.
 *
 * - `storefront_profiles`: one row per location (display name, short description, announcement, public contact and
 *   address text, optional accent color). Absent row = nothing customized (pages fall back to the location name).
 * - `storefront_featured_items`: menu items the restaurant chose to feature (manual; no popularity claims).
 * - `storefront_images`: logo and cover photo, with the SAME lifecycle and key rules as menu photos
 *   (pending -> active -> retired -> deleted; one active image per location and kind; opaque tenant-prefixed keys).
 *
 * Purely additive. Ownership: storefront -> storefront_*.
 */
import { type Kysely, sql } from "kysely";
import { roleNames } from "./roles.js";

export async function up(db: Kysely<unknown>): Promise<void> {
  const { app } = roleNames();
  await sql
    .raw(
      `
CREATE TABLE app.storefront_profiles (
  location_id     uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  display_name    text CHECK (char_length(display_name) BETWEEN 1 AND 60),
  description_ja  text CHECK (char_length(description_ja) BETWEEN 1 AND 300),
  description_en  text CHECK (char_length(description_en) BETWEEN 1 AND 300),
  announcement_ja text CHECK (char_length(announcement_ja) BETWEEN 1 AND 200),
  announcement_en text CHECK (char_length(announcement_en) BETWEEN 1 AND 200),
  phone           text CHECK (phone ~ '^[0-9+() -]{6,20}$'),
  address_ja      text CHECK (char_length(address_ja) BETWEEN 1 AND 200),
  address_en      text CHECK (char_length(address_en) BETWEEN 1 AND 200),
  accent_color    text CHECK (accent_color ~ '^#[0-9a-f]{6}$'),
  version         integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by      uuid REFERENCES app.users(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, location_id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id)
);

CREATE TABLE app.storefront_featured_items (
  tenant_id    uuid NOT NULL,
  location_id  uuid NOT NULL,
  menu_item_id uuid NOT NULL,
  sort_order   integer NOT NULL CHECK (sort_order BETWEEN 0 AND 99),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, menu_item_id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id),
  FOREIGN KEY (tenant_id, menu_item_id) REFERENCES app.menu_items (tenant_id, id)
);

CREATE TABLE app.storefront_images (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  location_id         uuid NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('logo', 'cover')),
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'active', 'retired', 'deleted')),
  storage_key         text NOT NULL UNIQUE,
  thumb_storage_key   text NOT NULL UNIQUE,
  content_type        text NOT NULL CHECK (content_type = 'image/webp'),
  width               integer NOT NULL CHECK (width BETWEEN 1 AND 4096),
  height              integer NOT NULL CHECK (height BETWEEN 1 AND 4096),
  byte_size           integer NOT NULL CHECK (byte_size BETWEEN 1 AND 20971520),
  thumb_width         integer NOT NULL CHECK (thumb_width BETWEEN 1 AND 1024),
  thumb_height        integer NOT NULL CHECK (thumb_height BETWEEN 1 AND 1024),
  thumb_byte_size     integer NOT NULL CHECK (thumb_byte_size BETWEEN 1 AND 20971520),
  source_content_type text NOT NULL CHECK (source_content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  source_byte_size    integer NOT NULL CHECK (source_byte_size > 0),
  uploaded_by         uuid REFERENCES app.users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  activated_at        timestamptz,
  retired_at          timestamptz,
  deleted_at          timestamptz,
  cleanup_attempts    integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id),
  CHECK (storage_key ~ ('^storefront-images/' || tenant_id::text || '/[A-Za-z0-9_-]{22}/main\\.webp$')),
  CHECK (thumb_storage_key ~ ('^storefront-images/' || tenant_id::text || '/[A-Za-z0-9_-]{22}/thumb\\.webp$')),
  CHECK ((status = 'active') = (activated_at IS NOT NULL AND retired_at IS NULL)
         OR status IN ('retired', 'deleted')),
  CHECK (status <> 'deleted' OR deleted_at IS NOT NULL)
);
CREATE UNIQUE INDEX storefront_images_one_active_uq ON app.storefront_images (location_id, kind)
  WHERE status = 'active';
CREATE INDEX storefront_images_cleanup_idx ON app.storefront_images (tenant_id, created_at)
  WHERE status IN ('pending', 'retired');

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['storefront_profiles', 'storefront_featured_items', 'storefront_images']
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON app.%I USING (tenant_id = app.current_tenant_id())
                    WITH CHECK (tenant_id = app.current_tenant_id())', t);
  END LOOP;
END $$;

-- Profiles are edited, never removed; image rows are tombstoned ('deleted'), never removed.
REVOKE DELETE ON app.storefront_profiles FROM ${app};
REVOKE DELETE ON app.storefront_images FROM ${app};
`,
    )
    .execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS app.storefront_images, app.storefront_featured_items, app.storefront_profiles`.execute(
    db,
  );
}
