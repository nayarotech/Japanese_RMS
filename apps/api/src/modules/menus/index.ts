/**
 * menus: categories, items, prices, availability, translations (ja required, en optional).
 * Prices here are authoritative inputs for orders; clients never send prices.
 *
 * Tax channel: Japanese consumption tax differs for eating in (10%) and takeout/delivery food (reduced 8%).
 * Each item has a dine-in rate and an optional takeout rate (defaults to the dine-in rate when not set).
 * PENDING partner/accountant approval of the per-item rates (docs/architecture/15-online-ordering.md).
 */
export type TaxChannel = "dine_in" | "takeout";
import type { Tx } from "../../infrastructure/database/db.js";
import type { ObjectStorage } from "../../infrastructure/storage/object-storage.js";
import { Errors } from "../../shared/errors/app-error.js";
import { type MenuImageView, toImageView } from "./images/index.js";

export type { MenuImageView } from "./images/index.js";

export interface LocalizedText {
  ja: string;
  en: string | null;
}

export interface MenuItemView {
  id: string;
  categoryId: string;
  code: string | null;
  name: LocalizedText;
  description: { ja: string | null; en: string | null };
  priceYen: number;
  taxRateBp: number;
  taxRateId: string;
  takeoutTaxRateId: string | null;
  takeoutTaxRateBp: number;
  isAvailable: boolean;
  isActive: boolean;
  sortOrder: number;
  version: number;
  /** Primary photo (delivery URLs + dimensions only), or null when the item has none (clients show a placeholder). */
  image: MenuImageView | null;
}

export interface MenuCategoryView {
  id: string;
  name: LocalizedText;
  sortOrder: number;
  items: MenuItemView[];
}

/**
 * Menu for a location. `publicView` returns only active categories/items (availability still shown).
 * This is the single read model behind admin menu management, the POS, the table QR menu and online ordering,
 * so every interface shows the same photo for an item.
 */
export async function getMenu(
  tx: Tx,
  locationId: string,
  opts: { publicView: boolean; storage: ObjectStorage },
): Promise<MenuCategoryView[]> {
  let catQuery = tx
    .selectFrom("menu_categories as c")
    .leftJoin("menu_category_translations as tja", (j) =>
      j.onRef("tja.category_id", "=", "c.id").on("tja.locale", "=", "ja"),
    )
    .leftJoin("menu_category_translations as ten", (j) =>
      j.onRef("ten.category_id", "=", "c.id").on("ten.locale", "=", "en"),
    )
    .select(["c.id", "c.sort_order", "tja.name as name_ja", "ten.name as name_en"])
    .where("c.location_id", "=", locationId);
  if (opts.publicView) catQuery = catQuery.where("c.is_active", "=", true);
  const categories = await catQuery.orderBy("c.sort_order").orderBy("c.id").execute();

  let itemQuery = tx
    .selectFrom("menu_items as i")
    .innerJoin("tax_rates as tr", "tr.id", "i.tax_rate_id")
    .leftJoin("tax_rates as ttr", "ttr.id", "i.takeout_tax_rate_id")
    .leftJoin("menu_item_translations as tja", (j) =>
      j.onRef("tja.menu_item_id", "=", "i.id").on("tja.locale", "=", "ja"),
    )
    .leftJoin("menu_item_translations as ten", (j) =>
      j.onRef("ten.menu_item_id", "=", "i.id").on("ten.locale", "=", "en"),
    )
    .leftJoin("menu_item_images as img", (j) =>
      j.onRef("img.menu_item_id", "=", "i.id").on("img.status", "=", "active"),
    )
    .select([
      "i.id",
      "i.category_id",
      "i.tax_rate_id",
      "i.takeout_tax_rate_id",
      "ttr.rate_bp as takeout_rate_bp",
      "i.code",
      "i.price_yen",
      "i.is_available",
      "i.is_active",
      "i.sort_order",
      "i.version",
      "tr.rate_bp",
      "tja.name as name_ja",
      "tja.description as desc_ja",
      "ten.name as name_en",
      "ten.description as desc_en",
      "img.storage_key as img_key",
      "img.thumb_storage_key as img_thumb_key",
      "img.width as img_width",
      "img.height as img_height",
      "img.thumb_width as img_thumb_width",
      "img.thumb_height as img_thumb_height",
    ])
    .where("i.location_id", "=", locationId);
  if (opts.publicView) itemQuery = itemQuery.where("i.is_active", "=", true);
  const items = await itemQuery.orderBy("i.sort_order").orderBy("i.id").execute();

  const byCategory = new Map<string, MenuItemView[]>();
  for (const i of items) {
    const view: MenuItemView = {
      id: i.id,
      categoryId: i.category_id,
      code: i.code,
      name: { ja: i.name_ja ?? "", en: i.name_en },
      description: { ja: i.desc_ja, en: i.desc_en },
      priceYen: i.price_yen,
      taxRateBp: i.rate_bp,
      taxRateId: i.tax_rate_id,
      takeoutTaxRateId: i.takeout_tax_rate_id,
      takeoutTaxRateBp: i.takeout_rate_bp ?? i.rate_bp,
      isAvailable: i.is_available,
      isActive: i.is_active,
      sortOrder: i.sort_order,
      version: i.version,
      image:
        i.img_key && i.img_thumb_key
          ? toImageView(opts.storage, {
              storage_key: i.img_key,
              thumb_storage_key: i.img_thumb_key,
              width: i.img_width ?? 0,
              height: i.img_height ?? 0,
              thumb_width: i.img_thumb_width ?? 0,
              thumb_height: i.img_thumb_height ?? 0,
            })
          : null,
    };
    const list = byCategory.get(i.category_id) ?? [];
    list.push(view);
    byCategory.set(i.category_id, list);
  }
  return categories.map((c) => ({
    id: c.id,
    name: { ja: c.name_ja ?? "", en: c.name_en },
    sortOrder: c.sort_order,
    items: byCategory.get(c.id) ?? [],
  }));
}

export interface OrderableItem {
  id: string;
  nameJa: string;
  nameEn: string | null;
  priceYen: number;
  taxRateBp: number;
}

/**
 * Loads items for an order at their CURRENT server-side price and the tax rate of the channel
 * (dine-in or takeout/delivery). Throws if any id is unknown, inactive, unavailable, or belongs to another location.
 */
export async function getOrderableItems(
  tx: Tx,
  locationId: string,
  ids: readonly string[],
  channel: TaxChannel = "dine_in",
): Promise<Map<string, OrderableItem>> {
  const unique = [...new Set(ids)];
  const rows = await tx
    .selectFrom("menu_items as i")
    .innerJoin("menu_categories as c", "c.id", "i.category_id")
    .innerJoin("tax_rates as tr", "tr.id", "i.tax_rate_id")
    .leftJoin("tax_rates as ttr", "ttr.id", "i.takeout_tax_rate_id")
    .leftJoin("menu_item_translations as tja", (j) =>
      j.onRef("tja.menu_item_id", "=", "i.id").on("tja.locale", "=", "ja"),
    )
    .leftJoin("menu_item_translations as ten", (j) =>
      j.onRef("ten.menu_item_id", "=", "i.id").on("ten.locale", "=", "en"),
    )
    .select([
      "i.id",
      "i.price_yen",
      "ttr.rate_bp as takeout_rate_bp",
      "i.is_available",
      "i.is_active",
      "c.is_active as category_active",
      "tr.rate_bp",
      "tja.name as name_ja",
      "ten.name as name_en",
    ])
    .where("i.location_id", "=", locationId)
    .where("i.id", "in", unique)
    .execute();
  const map = new Map<string, OrderableItem>();
  for (const r of rows) {
    if (!r.is_active || !r.category_active) continue;
    if (!r.is_available)
      throw Errors.unprocessable("item_unavailable", "An item is sold out", { menuItemId: r.id });
    map.set(r.id, {
      id: r.id,
      nameJa: r.name_ja ?? "",
      nameEn: r.name_en,
      priceYen: r.price_yen,
      taxRateBp: channel === "takeout" ? (r.takeout_rate_bp ?? r.rate_bp) : r.rate_bp,
    });
  }
  const missing = unique.filter((id) => !map.has(id));
  if (missing.length > 0)
    throw Errors.unprocessable("item_not_found", "Unknown menu item", { menuItemIds: missing });
  return map;
}

export async function setItemAvailability(
  tx: Tx,
  locationId: string,
  itemId: string,
  isAvailable: boolean,
): Promise<void> {
  const res = await tx
    .updateTable("menu_items")
    .set((eb) => ({
      is_available: isAvailable,
      version: eb("version", "+", 1),
      updated_at: new Date(),
    }))
    .where("id", "=", itemId)
    .where("location_id", "=", locationId)
    .executeTakeFirst();
  if (res.numUpdatedRows === 0n) throw Errors.notFound("menu item");
}

export interface MenuItemInput {
  categoryId: string;
  code?: string | null | undefined;
  priceYen: number;
  taxRateId: string;
  takeoutTaxRateId?: string | null | undefined;
  nameJa: string;
  nameEn?: string | null | undefined;
  descriptionJa?: string | null | undefined;
  descriptionEn?: string | null | undefined;
  sortOrder?: number | undefined;
}

export async function createMenuItem(
  tx: Tx,
  tenantId: string,
  locationId: string,
  input: MenuItemInput,
): Promise<string> {
  await assertCategoryAndTax(tx, locationId, input.categoryId, input.taxRateId);
  if (input.takeoutTaxRateId) await assertTaxRate(tx, locationId, input.takeoutTaxRateId);
  const item = await tx
    .insertInto("menu_items")
    .values({
      tenant_id: tenantId,
      location_id: locationId,
      category_id: input.categoryId,
      code: input.code ?? null,
      price_yen: input.priceYen,
      tax_rate_id: input.taxRateId,
      takeout_tax_rate_id: input.takeoutTaxRateId ?? null,
      sort_order: input.sortOrder ?? 0,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await upsertItemTranslations(tx, tenantId, item.id, input);
  return item.id;
}

export async function updateMenuItem(
  tx: Tx,
  tenantId: string,
  locationId: string,
  itemId: string,
  version: number,
  input: MenuItemInput & { isActive?: boolean | undefined },
): Promise<void> {
  await assertCategoryAndTax(tx, locationId, input.categoryId, input.taxRateId);
  if (input.takeoutTaxRateId) await assertTaxRate(tx, locationId, input.takeoutTaxRateId);
  const res = await tx
    .updateTable("menu_items")
    .set((eb) => ({
      category_id: input.categoryId,
      code: input.code ?? null,
      price_yen: input.priceYen,
      tax_rate_id: input.taxRateId,
      ...(input.takeoutTaxRateId === undefined
        ? {}
        : { takeout_tax_rate_id: input.takeoutTaxRateId }),
      sort_order: input.sortOrder ?? 0,
      ...(input.isActive === undefined ? {} : { is_active: input.isActive }),
      version: eb("version", "+", 1),
      updated_at: new Date(),
    }))
    .where("id", "=", itemId)
    .where("location_id", "=", locationId)
    .where("version", "=", version)
    .executeTakeFirst();
  if (res.numUpdatedRows === 0n)
    throw Errors.conflict("version_conflict", "Menu item was changed by someone else");
  await upsertItemTranslations(tx, tenantId, itemId, input);
}

export async function createCategory(
  tx: Tx,
  tenantId: string,
  locationId: string,
  input: { nameJa: string; nameEn?: string | null | undefined; sortOrder?: number | undefined },
): Promise<string> {
  const cat = await tx
    .insertInto("menu_categories")
    .values({ tenant_id: tenantId, location_id: locationId, sort_order: input.sortOrder ?? 0 })
    .returning("id")
    .executeTakeFirstOrThrow();
  await tx
    .insertInto("menu_category_translations")
    .values({ tenant_id: tenantId, category_id: cat.id, locale: "ja", name: input.nameJa })
    .execute();
  if (input.nameEn) {
    await tx
      .insertInto("menu_category_translations")
      .values({ tenant_id: tenantId, category_id: cat.id, locale: "en", name: input.nameEn })
      .execute();
  }
  return cat.id;
}

async function assertCategoryAndTax(
  tx: Tx,
  locationId: string,
  categoryId: string,
  taxRateId: string,
): Promise<void> {
  const [cat, tax] = await Promise.all([
    tx
      .selectFrom("menu_categories")
      .select("id")
      .where("id", "=", categoryId)
      .where("location_id", "=", locationId)
      .executeTakeFirst(),
    tx
      .selectFrom("tax_rates")
      .select("id")
      .where("id", "=", taxRateId)
      .where("location_id", "=", locationId)
      .executeTakeFirst(),
  ]);
  if (!cat)
    throw Errors.unprocessable("invalid_category", "Category does not belong to this location");
  if (!tax)
    throw Errors.unprocessable("invalid_tax_rate", "Tax rate does not belong to this location");
}

async function assertTaxRate(tx: Tx, locationId: string, taxRateId: string): Promise<void> {
  const tax = await tx
    .selectFrom("tax_rates")
    .select("id")
    .where("id", "=", taxRateId)
    .where("location_id", "=", locationId)
    .executeTakeFirst();
  if (!tax)
    throw Errors.unprocessable("invalid_tax_rate", "Tax rate does not belong to this location");
}

async function upsertItemTranslations(
  tx: Tx,
  tenantId: string,
  itemId: string,
  input: MenuItemInput,
): Promise<void> {
  const rows: { locale: "ja" | "en"; name: string; description: string | null }[] = [
    { locale: "ja", name: input.nameJa, description: input.descriptionJa ?? null },
  ];
  if (input.nameEn)
    rows.push({ locale: "en", name: input.nameEn, description: input.descriptionEn ?? null });
  for (const r of rows) {
    await tx
      .insertInto("menu_item_translations")
      .values({ tenant_id: tenantId, menu_item_id: itemId, ...r })
      .onConflict((oc) =>
        oc
          .columns(["menu_item_id", "locale"])
          .doUpdateSet({ name: r.name, description: r.description }),
      )
      .execute();
  }
  if (!input.nameEn) {
    await tx
      .deleteFrom("menu_item_translations")
      .where("menu_item_id", "=", itemId)
      .where("locale", "=", "en")
      .execute();
  }
}
