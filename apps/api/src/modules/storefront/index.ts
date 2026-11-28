/**
 * storefront: how a branch presents itself to customers on the table-QR and online-ordering pages.
 *
 * This is the RESTAURANT-level customization inside the partner brand (docs/architecture/05-white-label-branding.md):
 * display name, short description, announcement, public contact/address text, logo, cover photo, an optional accent
 * color and manually chosen featured dishes. It can never change the partner brand (name, marks, support, legal).
 * Everything here is plain text; clients render it as text, never as HTML.
 */
import type { Tx } from "../../infrastructure/database/db.js";
import type { ObjectStorage } from "../../infrastructure/storage/object-storage.js";
import { Errors } from "../../shared/errors/app-error.js";
import type { StaffContext } from "../../shared/types/access-context.js";
import { type MenuImageView, toImageView } from "../menus/images/index.js";

export {
  loadServableStorefrontImage,
  purgeRetiredStorefrontImages,
  removeStorefrontImage,
  setStorefrontImage,
} from "./images.js";

export const MAX_FEATURED_ITEMS = 8;

export interface LocalizedOptional {
  ja: string | null;
  en: string | null;
}

/** Public presentation of a branch. Every field is optional; clients fall back to the location name. */
export interface StorefrontProfileView {
  displayName: string | null;
  description: LocalizedOptional;
  announcement: LocalizedOptional;
  phone: string | null;
  address: LocalizedOptional;
  accentColor: string | null;
  logo: MenuImageView | null;
  cover: MenuImageView | null;
}

export interface StorefrontSettingsView {
  version: number;
  profile: StorefrontProfileView;
  featuredItemIds: string[];
}

export interface StorefrontSettingsInput {
  version: number;
  displayName: string | null;
  description: LocalizedOptional;
  announcement: LocalizedOptional;
  phone: string | null;
  address: LocalizedOptional;
  accentColor: string | null;
  featuredItemIds: string[];
}

// ---------------------------------------------------------------- accent color

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG contrast ratio of a #rrggbb color against white. */
export function contrastWithWhite(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const l =
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255);
  return 1.05 / (l + 0.05);
}

/** An accent color is used behind white text (buttons, chips), so it must keep AA contrast (4.5:1) with white. */
export function assertAccentColor(hex: string | null): void {
  if (hex === null) return;
  if (!/^#[0-9a-f]{6}$/.test(hex)) throw Errors.validation({ accentColor: "Use #rrggbb" });
  if (contrastWithWhite(hex) < 4.5)
    throw Errors.unprocessable(
      "accent_color_low_contrast",
      "This color is too light for white text. Choose a darker color.",
    );
}

// ---------------------------------------------------------------- reads

const EMPTY_PROFILE: Omit<StorefrontProfileView, "logo" | "cover"> = {
  displayName: null,
  description: { ja: null, en: null },
  announcement: { ja: null, en: null },
  phone: null,
  address: { ja: null, en: null },
  accentColor: null,
};

async function readProfileRow(tx: Tx, locationId: string) {
  return tx
    .selectFrom("storefront_profiles")
    .selectAll()
    .where("location_id", "=", locationId)
    .executeTakeFirst();
}

async function readImages(tx: Tx, locationId: string, storage: ObjectStorage) {
  const rows = await tx
    .selectFrom("storefront_images")
    .select([
      "kind",
      "storage_key",
      "thumb_storage_key",
      "width",
      "height",
      "thumb_width",
      "thumb_height",
    ])
    .where("location_id", "=", locationId)
    .where("status", "=", "active")
    .execute();
  const view = (kind: "logo" | "cover") => {
    const r = rows.find((x) => x.kind === kind);
    return r ? toImageView(storage, r) : null;
  };
  return { logo: view("logo"), cover: view("cover") };
}

export async function getStorefrontProfile(
  tx: Tx,
  locationId: string,
  storage: ObjectStorage,
): Promise<StorefrontProfileView> {
  const [row, images] = await Promise.all([
    readProfileRow(tx, locationId),
    readImages(tx, locationId, storage),
  ]);
  if (!row) return { ...EMPTY_PROFILE, ...images };
  return {
    displayName: row.display_name,
    description: { ja: row.description_ja, en: row.description_en },
    announcement: { ja: row.announcement_ja, en: row.announcement_en },
    phone: row.phone,
    address: { ja: row.address_ja, en: row.address_en },
    accentColor: row.accent_color,
    ...images,
  };
}

/** Featured item ids in display order (inactive items are filtered out by the caller's public menu). */
export async function getFeaturedItemIds(tx: Tx, locationId: string): Promise<string[]> {
  const rows = await tx
    .selectFrom("storefront_featured_items")
    .select("menu_item_id")
    .where("location_id", "=", locationId)
    .orderBy("sort_order")
    .execute();
  return rows.map((r) => r.menu_item_id);
}

export async function getStorefrontSettings(
  tx: Tx,
  locationId: string,
  storage: ObjectStorage,
): Promise<StorefrontSettingsView> {
  const [row, profile, featuredItemIds] = await Promise.all([
    readProfileRow(tx, locationId),
    getStorefrontProfile(tx, locationId, storage),
    getFeaturedItemIds(tx, locationId),
  ]);
  // Version 0 = never saved; the first save must send 0.
  return { version: row?.version ?? 0, profile, featuredItemIds };
}

// ---------------------------------------------------------------- writes

const clean = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

/**
 * Saves the profile and the featured list atomically, with optimistic concurrency (a concurrent edit by another
 * manager is rejected, never silently overwritten).
 */
export async function saveStorefrontSettings(
  tx: Tx,
  ctx: StaffContext,
  input: StorefrontSettingsInput,
): Promise<void> {
  const accent = clean(input.accentColor)?.toLowerCase() ?? null;
  assertAccentColor(accent);
  const ids = [...new Set(input.featuredItemIds)];
  if (ids.length > MAX_FEATURED_ITEMS)
    throw Errors.validation({ featuredItemIds: `At most ${String(MAX_FEATURED_ITEMS)} items` });
  if (ids.length > 0) {
    const found = await tx
      .selectFrom("menu_items")
      .select("id")
      .where("location_id", "=", ctx.locationId)
      .where("id", "in", ids)
      .execute();
    if (found.length !== ids.length)
      throw Errors.unprocessable("invalid_featured_item", "A featured item is not on this menu");
  }

  const values = {
    display_name: clean(input.displayName),
    description_ja: clean(input.description.ja),
    description_en: clean(input.description.en),
    announcement_ja: clean(input.announcement.ja),
    announcement_en: clean(input.announcement.en),
    phone: clean(input.phone),
    address_ja: clean(input.address.ja),
    address_en: clean(input.address.en),
    accent_color: accent,
    updated_by: ctx.userId,
    updated_at: new Date(),
  };

  if (input.version === 0) {
    const inserted = await tx
      .insertInto("storefront_profiles")
      .values({ tenant_id: ctx.tenantId, location_id: ctx.locationId, ...values })
      .onConflict((oc) => oc.column("location_id").doNothing())
      .returning("location_id")
      .executeTakeFirst();
    if (!inserted)
      throw Errors.conflict("version_conflict", "Storefront settings were changed by someone else");
  } else {
    const updated = await tx
      .updateTable("storefront_profiles")
      .set((eb) => ({ ...values, version: eb("version", "+", 1) }))
      .where("location_id", "=", ctx.locationId)
      .where("version", "=", input.version)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n)
      throw Errors.conflict("version_conflict", "Storefront settings were changed by someone else");
  }

  await tx
    .deleteFrom("storefront_featured_items")
    .where("location_id", "=", ctx.locationId)
    .execute();
  if (ids.length > 0) {
    await tx
      .insertInto("storefront_featured_items")
      .values(
        ids.map((id, i) => ({
          tenant_id: ctx.tenantId,
          location_id: ctx.locationId,
          menu_item_id: id,
          sort_order: i,
        })),
      )
      .execute();
  }
}
