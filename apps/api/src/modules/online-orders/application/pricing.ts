/**
 * Authoritative online-order money: item lines at current server prices (takeout tax channel) plus the delivery fee
 * calculated from the server-verified distance. Clients never send prices, fees or totals; the customer's reviewed
 * total is only compared, never used.
 */
import type { Tx } from "../../../infrastructure/database/db.js";
import { AppError, Errors } from "../../../shared/errors/app-error.js";
import {
  type GeocodeResult,
  type Geocoder,
  GeocodingUnavailableError,
} from "../../integrations/index.js";
import { type PricedLine, computeBill } from "../../orders/index.js";
import { type LocationSettings, listTaxRates } from "../../restaurants/index.js";
import {
  type FeeTier,
  type LatLng,
  cleanText,
  deliveryRadiusM,
  normalizePostalCode,
  straightLineMeters,
  tierFor,
} from "../domain/delivery.js";

export interface OnlineTotals {
  itemsSubtotalYen: number;
  deliveryFeeYen: number;
  taxBreakdown: { rateBp: number; baseYen: number; taxYen: number }[];
  taxTotalYen: number;
  totalYen: number;
  pricesIncludeTax: boolean;
}

export function computeOnlineTotals(
  lines: readonly PricedLine[],
  fee: { feeYen: number; taxRateBp: number } | null,
  location: Pick<LocationSettings, "pricesIncludeTax" | "taxRounding">,
): OnlineTotals {
  const feeLines =
    fee && fee.feeYen > 0
      ? [{ unitPriceYen: fee.feeYen, quantity: 1, taxRateBp: fee.taxRateBp }]
      : [];
  const bill = computeBill([...lines, ...feeLines], {
    pricesIncludeTax: location.pricesIncludeTax,
    rounding: location.taxRounding,
  });
  return {
    itemsSubtotalYen: lines.reduce((s, l) => s + l.unitPriceYen * l.quantity, 0),
    deliveryFeeYen: fee?.feeYen ?? 0,
    taxBreakdown: bill.taxBreakdown,
    taxTotalYen: bill.taxTotalYen,
    totalYen: bill.totalYen,
    pricesIncludeTax: bill.pricesIncludeTax,
  };
}

/**
 * Delivery is a service, taxed at the standard rate (not the reduced food rate). Uses the location's `standard` tax
 * rate, else its highest rate. PENDING accountant approval.
 */
export async function deliveryFeeTaxRateBp(tx: Tx, locationId: string): Promise<number> {
  const rates = await listTaxRates(tx, locationId);
  const standard = rates.find((r) => r.code === "standard");
  if (standard) return standard.rateBp;
  if (rates.length === 0)
    throw Errors.unprocessable("tax_not_configured", "No tax rate is configured for this store");
  return Math.max(...rates.map((r) => r.rateBp));
}

// ---------------------------------------------------------------- delivery address verification

export interface AddressInput {
  postalCode: string;
  prefecture: string;
  city: string;
  line1: string;
  line2?: string | null | undefined;
  instructions?: string | null | undefined;
}

export interface VerifiedAddress {
  postalCode: string;
  prefecture: string;
  city: string;
  line1: string;
  line2: string | null;
  instructions: string | null;
  location: LatLng;
  precision: GeocodeResult["precision"];
}

const ACCEPTED_PRECISION = new Set<GeocodeResult["precision"]>([
  "rooftop",
  "street",
  "postal_code",
]);

/**
 * Geocodes on the SERVER (never trusts browser coordinates). Run OUTSIDE the database transaction.
 * Failure behaviour (fail closed): provider down/slow -> 503 geocoding_unavailable (customer may retry or choose
 * pickup); address unknown -> 422 address_not_found; only a city/prefecture match -> 422 address_not_precise.
 */
export async function verifyAddress(
  geocoder: Geocoder,
  input: AddressInput,
): Promise<VerifiedAddress> {
  const postalCode = normalizePostalCode(input.postalCode);
  const prefecture = cleanText(input.prefecture, 10);
  const city = cleanText(input.city, 60);
  const line1 = cleanText(input.line1, 120);
  if (!postalCode || !prefecture || !city || !line1)
    throw Errors.validation({ address: "postal code, prefecture, city and street are required" });
  if (!geocoder.enabled)
    throw Errors.conflict("delivery_unavailable", "Delivery is not available right now");
  let result: GeocodeResult | null;
  try {
    result = await geocoder.geocode({
      postalCode,
      prefecture,
      city,
      line1,
      line2: cleanText(input.line2, 120),
    });
  } catch (err) {
    if (err instanceof GeocodingUnavailableError)
      throw new AppError(
        503,
        "geocoding_unavailable",
        "The address could not be checked right now",
      );
    throw err;
  }
  if (!result) throw Errors.unprocessable("address_not_found", "The address could not be found");
  if (!ACCEPTED_PRECISION.has(result.precision))
    throw Errors.unprocessable("address_not_precise", "Please enter the full street address");
  return {
    postalCode,
    prefecture,
    city,
    line1,
    line2: cleanText(input.line2, 120),
    instructions: cleanText(input.instructions, 200),
    location: { latitude: result.latitude, longitude: result.longitude },
    precision: result.precision,
  };
}

/** Distance (straight line) and the applicable fee tier, or 422 outside_delivery_area. */
export function deliveryTierFor(
  store: LatLng | null,
  tiers: readonly FeeTier[],
  address: VerifiedAddress,
): { distanceM: number; tier: FeeTier } {
  if (!store || tiers.length === 0)
    throw Errors.conflict("delivery_unavailable", "Delivery is not available right now");
  const distanceM = straightLineMeters(store, address.location);
  const tier = tierFor(tiers, distanceM);
  if (!tier) {
    throw Errors.unprocessable(
      "outside_delivery_area",
      "This address is outside the delivery area",
      {
        radiusM: deliveryRadiusM(tiers),
      },
    );
  }
  return { distanceM, tier };
}
