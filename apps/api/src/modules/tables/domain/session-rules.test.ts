import { describe, expect, it } from "vitest";
import {
  assertAcceptsOrders,
  nextStatusForBillRequest,
  nextStatusForReopen,
} from "./session-rules.js";

describe("session rules", () => {
  it("accepts orders only while open", () => {
    expect(() => assertAcceptsOrders("open")).not.toThrow();
    expect(() => assertAcceptsOrders("bill_requested")).toThrow(/paused/);
    expect(() => assertAcceptsOrders("closed")).toThrow(/closed/);
  });
  it("bill request and reopen transitions", () => {
    expect(nextStatusForBillRequest("open")).toBe("bill_requested");
    expect(() => nextStatusForBillRequest("closed")).toThrow();
    expect(nextStatusForReopen("bill_requested")).toBe("open");
    expect(() => nextStatusForReopen("open")).toThrow();
  });
});
