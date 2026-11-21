import { describe, expect, it } from "vitest";
import {
  cleanText,
  normalizePhone,
  normalizePostalCode,
  straightLineMeters,
  tierFor,
  validateTiers,
} from "./delivery.js";

const TIERS = [
  { maxDistanceM: 4000, feeYen: 300, minOrderYen: 2000 },
  { maxDistanceM: 2000, feeYen: 0, minOrderYen: 1500 },
];

describe("delivery distance and tiers", () => {
  it("computes straight-line distance in metres", () => {
    // Tokyo Station -> Shinjuku Station is roughly 6.2 km in a straight line.
    const d = straightLineMeters(
      { latitude: 35.6812, longitude: 139.7671 },
      { latitude: 35.6896, longitude: 139.7006 },
    );
    expect(d).toBeGreaterThan(6000);
    expect(d).toBeLessThan(6300);
  });

  it("picks the smallest tier that covers the distance, or none outside the radius", () => {
    expect(tierFor(TIERS, 1999)?.feeYen).toBe(0);
    expect(tierFor(TIERS, 2000)?.feeYen).toBe(0);
    expect(tierFor(TIERS, 2001)?.feeYen).toBe(300);
    expect(tierFor(TIERS, 4001)).toBeNull();
    expect(validateTiers([...TIERS, { maxDistanceM: 2000, feeYen: 1, minOrderYen: 0 }])).toBe(
      "duplicate_tier_distance",
    );
  });
});

describe("customer input normalization", () => {
  it("accepts common Japanese phone formats", () => {
    expect(normalizePhone("03-1234-5678")).toBe("0312345678");
    expect(normalizePhone("０９０ー１２３４ー５６７８")).toBe("09012345678");
    expect(normalizePhone("+81 90 1234 5678")).toBe("09012345678");
    expect(normalizePhone("12345")).toBeNull();
    expect(normalizePhone("090-1234-5678; DROP TABLE")).toBeNull();
  });

  it("accepts postal codes with or without the mark and hyphen", () => {
    expect(normalizePostalCode("〒150-0002")).toBe("1500002");
    expect(normalizePostalCode("１５０−０００２")).toBe("1500002");
    expect(normalizePostalCode("150-00")).toBeNull();
  });

  it("strips control and bidi characters from free text", () => {
    expect(cleanText("  Ring\nthe bell‮ ", 200)).toBe("Ring the bell");
    expect(cleanText("   ", 200)).toBeNull();
  });
});
