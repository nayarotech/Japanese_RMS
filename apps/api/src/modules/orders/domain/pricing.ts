/**
 * Authoritative bill calculation. Integer yen only; BigInt for intermediate products so rounding is exact.
 *
 * ASSUMPTIONS PENDING PARTNER/ACCOUNTANT APPROVAL (docs/architecture/11-localization.md):
 *  - Tax is computed once PER RATE PER BILL (not per line), matching the qualified-invoice approach.
 *  - Rounding mode is a location setting (default: floor / 切り捨て).
 *  - Tax-inclusive (内税) prices: tax = base × r / (1 + r). Tax-exclusive (外税): tax = base × r.
 */
export type TaxRounding = "floor" | "round" | "ceil";

export interface PricedLine {
  unitPriceYen: number;
  quantity: number;
  taxRateBp: number;
}

export interface TaxBreakdownEntry {
  rateBp: number;
  /** Sum of line totals at this rate, as priced (gross if inclusive, net if exclusive). */
  baseYen: number;
  taxYen: number;
}

export interface BillTotals {
  subtotalYen: number;
  taxBreakdown: TaxBreakdownEntry[];
  taxTotalYen: number;
  totalYen: number;
  pricesIncludeTax: boolean;
}

export interface TaxSettings {
  pricesIncludeTax: boolean;
  rounding: TaxRounding;
}

export function divideRounded(numerator: bigint, denominator: bigint, mode: TaxRounding): bigint {
  if (denominator <= 0n || numerator < 0n)
    throw new RangeError("divideRounded expects numerator >= 0 and denominator > 0");
  const q = numerator / denominator;
  const r = numerator % denominator;
  if (r === 0n) return q;
  switch (mode) {
    case "floor":
      return q;
    case "ceil":
      return q + 1n;
    case "round":
      return r * 2n >= denominator ? q + 1n : q;
  }
}

export function lineTotal(line: PricedLine): number {
  return line.unitPriceYen * line.quantity;
}

export function computeBill(lines: readonly PricedLine[], settings: TaxSettings): BillTotals {
  const byRate = new Map<number, bigint>();
  let subtotal = 0n;
  for (const l of lines) {
    if (
      !Number.isInteger(l.unitPriceYen) ||
      !Number.isInteger(l.quantity) ||
      l.unitPriceYen < 0 ||
      l.quantity < 1
    ) {
      throw new RangeError("Invalid line");
    }
    const total = BigInt(l.unitPriceYen) * BigInt(l.quantity);
    subtotal += total;
    byRate.set(l.taxRateBp, (byRate.get(l.taxRateBp) ?? 0n) + total);
  }
  const taxBreakdown: TaxBreakdownEntry[] = [...byRate.entries()]
    .sort(([a], [b]) => b - a)
    .map(([rateBp, base]) => {
      const rate = BigInt(rateBp);
      const tax = settings.pricesIncludeTax
        ? divideRounded(base * rate, 10_000n + rate, settings.rounding)
        : divideRounded(base * rate, 10_000n, settings.rounding);
      return { rateBp, baseYen: Number(base), taxYen: Number(tax) };
    });
  const taxTotal = taxBreakdown.reduce((s, t) => s + t.taxYen, 0);
  const subtotalYen = Number(subtotal);
  return {
    subtotalYen,
    taxBreakdown,
    taxTotalYen: taxTotal,
    totalYen: settings.pricesIncludeTax ? subtotalYen : subtotalYen + taxTotal,
    pricesIncludeTax: settings.pricesIncludeTax,
  };
}
