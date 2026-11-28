/** restaurants: branch/location settings used by ordering, tax and receipts. */
import type { Tx } from "../../infrastructure/database/db.js";
import type { TaxRounding } from "../../infrastructure/database/schema.js";
import { Errors } from "../../shared/errors/app-error.js";

export interface LocationSettings {
  id: string;
  tenantId: string;
  name: string;
  timeZone: string;
  pricesIncludeTax: boolean;
  taxRounding: TaxRounding;
  qrOrderingEnabled: boolean;
  receiptHeader: string | null;
  receiptFooter: string | null;
}

export async function getLocationSettings(tx: Tx, locationId: string): Promise<LocationSettings> {
  const row = await tx
    .selectFrom("locations")
    .selectAll()
    .where("id", "=", locationId)
    .executeTakeFirst();
  if (!row) throw Errors.notFound("location");
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    timeZone: row.time_zone,
    pricesIncludeTax: row.prices_include_tax,
    taxRounding: row.tax_rounding,
    qrOrderingEnabled: row.qr_ordering_enabled,
    receiptHeader: row.receipt_header,
    receiptFooter: row.receipt_footer,
  };
}

export async function listTaxRates(
  tx: Tx,
  locationId: string,
): Promise<{ id: string; code: string; rateBp: number }[]> {
  const rows = await tx
    .selectFrom("tax_rates")
    .select(["id", "code", "rate_bp"])
    .where("location_id", "=", locationId)
    .orderBy("rate_bp")
    .orderBy("code")
    .execute();
  return rows.map((r) => ({ id: r.id, code: r.code, rateBp: r.rate_bp }));
}

/**
 * Returns this location's tax rate for `rateBp`, creating a `custom_<bp>` rate when none exists yet. Lets managers
 * enter a new consumption-tax percentage without a deploy. Rates are never edited in place: order lines snapshot
 * `tax_rate_bp`, and reusing a row by value keeps the list free of duplicates.
 */
export async function ensureTaxRate(
  tx: Tx,
  tenantId: string,
  locationId: string,
  rateBp: number,
): Promise<{ id: string; code: string; rateBp: number; created: boolean }> {
  const find = () =>
    tx
      .selectFrom("tax_rates")
      .select(["id", "code", "rate_bp"])
      .where("location_id", "=", locationId)
      .where("rate_bp", "=", rateBp)
      .orderBy("created_at")
      .executeTakeFirst();
  const existing = await find();
  if (existing)
    return { id: existing.id, code: existing.code, rateBp: existing.rate_bp, created: false };

  const inserted = await tx
    .insertInto("tax_rates")
    .values({
      tenant_id: tenantId,
      location_id: locationId,
      code: `custom_${String(rateBp)}`,
      rate_bp: rateBp,
    })
    // A concurrent request may have created the same rate: fall back to reading it.
    .onConflict((oc) => oc.columns(["location_id", "code"]).doNothing())
    .returning(["id", "code", "rate_bp"])
    .executeTakeFirst();
  const row = inserted ?? (await find());
  if (!row) throw Errors.conflict("tax_rate_conflict", "Could not create the tax rate");
  return { id: row.id, code: row.code, rateBp: row.rate_bp, created: inserted !== undefined };
}
