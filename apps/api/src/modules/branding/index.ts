/**
 * branding: white-label brand resolution. Returns PUBLIC fields only.
 * An unknown host resolves to a neutral placeholder: never a hard-coded or developer brand.
 */
import type { Db, Tx } from "../../infrastructure/database/db.js";

export interface PublicBrand {
  displayName: string;
  shortMark: string;
  primaryColor: string;
  supportEmail: string | null;
  supportPhone: string | null;
}

export const NEUTRAL_BRAND: PublicBrand = {
  displayName: "Restaurant",
  shortMark: "R",
  primaryColor: "#db020e",
  supportEmail: null,
  supportPhone: null,
};

function toPublic(row: {
  display_name: string;
  short_mark: string;
  primary_color: string;
  support_email: string | null;
  support_phone: string | null;
}): PublicBrand {
  return {
    displayName: row.display_name,
    shortMark: row.short_mark,
    primaryColor: row.primary_color,
    supportEmail: row.support_email,
    supportPhone: row.support_phone,
  };
}

export async function resolveBrandByHost(db: Db, host: string): Promise<PublicBrand> {
  const normalized = host.toLowerCase().replace(/:\d+$/, "");
  const row = await db
    .selectFrom("brand_domains as d")
    .innerJoin("brands as b", "b.id", "d.brand_id")
    .select([
      "b.display_name",
      "b.short_mark",
      "b.primary_color",
      "b.support_email",
      "b.support_phone",
    ])
    .where("d.host", "=", normalized)
    .executeTakeFirst();
  return row ? toPublic(row) : NEUTRAL_BRAND;
}

/** Brand of the tenant (used on receipts and guest pages). Requires tenant context. */
export async function getTenantBrand(tx: Tx, tenantId: string): Promise<PublicBrand> {
  const row = await tx
    .selectFrom("tenants as t")
    .innerJoin("brands as b", "b.id", "t.brand_id")
    .select([
      "b.display_name",
      "b.short_mark",
      "b.primary_color",
      "b.support_email",
      "b.support_phone",
    ])
    .where("t.id", "=", tenantId)
    .executeTakeFirst();
  return row ? toPublic(row) : NEUTRAL_BRAND;
}
