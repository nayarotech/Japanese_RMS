import { describe, expect, it } from "vitest";
import { computeBill, divideRounded } from "./pricing.js";

const inclusiveFloor = { pricesIncludeTax: true, rounding: "floor" as const };

describe("computeBill", () => {
  it("matches the approved design example: ¥3,440 tax-inclusive at 10% contains ¥312 tax", () => {
    const bill = computeBill(
      [
        { unitPriceYen: 980, quantity: 2, taxRateBp: 1000 },
        { unitPriceYen: 550, quantity: 2, taxRateBp: 1000 },
        { unitPriceYen: 380, quantity: 1, taxRateBp: 1000 },
      ],
      inclusiveFloor,
    );
    expect(bill).toMatchObject({ subtotalYen: 3440, totalYen: 3440, taxTotalYen: 312 });
    expect(bill.taxBreakdown).toEqual([{ rateBp: 1000, baseYen: 3440, taxYen: 312 }]);
  });

  it("computes tax once per rate (not per line) and supports mixed rates", () => {
    const bill = computeBill(
      [
        { unitPriceYen: 101, quantity: 1, taxRateBp: 1000 },
        { unitPriceYen: 101, quantity: 1, taxRateBp: 1000 },
        { unitPriceYen: 540, quantity: 1, taxRateBp: 800 },
      ],
      inclusiveFloor,
    );
    // per-rate: floor(202*1000/11000)=18 (per-line would be 9+9=18 here, but see next case), floor(540*800/10800)=40
    expect(bill.taxBreakdown).toEqual([
      { rateBp: 1000, baseYen: 202, taxYen: 18 },
      { rateBp: 800, baseYen: 540, taxYen: 40 },
    ]);
    expect(bill.totalYen).toBe(742);
  });

  it("per-rate rounding differs from per-line rounding (documented assumption)", () => {
    // Three ¥105 items: per line floor(105/11)=9 each => 27; per rate floor(315/11)=28.
    const bill = computeBill([{ unitPriceYen: 105, quantity: 3, taxRateBp: 1000 }], inclusiveFloor);
    expect(bill.taxTotalYen).toBe(28);
  });

  it("supports tax-exclusive pricing and rounding modes", () => {
    const lines = [{ unitPriceYen: 999, quantity: 1, taxRateBp: 1000 }];
    expect(computeBill(lines, { pricesIncludeTax: false, rounding: "floor" })).toMatchObject({
      taxTotalYen: 99,
      totalYen: 1098,
    });
    expect(computeBill(lines, { pricesIncludeTax: false, rounding: "round" })).toMatchObject({
      taxTotalYen: 100,
      totalYen: 1099,
    });
    expect(computeBill(lines, { pricesIncludeTax: false, rounding: "ceil" })).toMatchObject({
      taxTotalYen: 100,
      totalYen: 1099,
    });
  });

  it("handles an empty bill and rejects invalid lines", () => {
    expect(computeBill([], inclusiveFloor)).toMatchObject({
      subtotalYen: 0,
      totalYen: 0,
      taxBreakdown: [],
    });
    expect(() =>
      computeBill([{ unitPriceYen: 1.5, quantity: 1, taxRateBp: 1000 }], inclusiveFloor),
    ).toThrow();
    expect(() =>
      computeBill([{ unitPriceYen: 100, quantity: 0, taxRateBp: 1000 }], inclusiveFloor),
    ).toThrow();
  });

  it("stays exact for large totals", () => {
    const bill = computeBill(
      [{ unitPriceYen: 9_999_999, quantity: 99, taxRateBp: 1000 }],
      inclusiveFloor,
    );
    expect(bill.subtotalYen).toBe(989_999_901);
    expect(bill.taxTotalYen).toBe(Number((989_999_901n * 1000n) / 11000n));
  });
});

describe("divideRounded", () => {
  it("rounds half up in round mode and never uses floating point", () => {
    expect(divideRounded(15n, 10n, "round")).toBe(2n);
    expect(divideRounded(14n, 10n, "round")).toBe(1n);
    expect(divideRounded(10n, 10n, "ceil")).toBe(1n);
    expect(divideRounded(11n, 10n, "ceil")).toBe(2n);
  });
});
