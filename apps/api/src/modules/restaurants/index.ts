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
    .execute();
  return rows.map((r) => ({ id: r.id, code: r.code, rateBp: r.rate_bp }));
}
