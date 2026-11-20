import { describe, expect, it } from "vitest";
import { assertTransition, deriveTicketStatus, isEditable } from "./status.js";

describe("kitchen item transitions", () => {
  it("allows only queued->preparing->ready->served", () => {
    expect(assertTransition("queued", "start")).toBe("preparing");
    expect(assertTransition("preparing", "ready")).toBe("ready");
    expect(assertTransition("ready", "serve")).toBe("served");
  });
  it.each([
    ["queued", "ready"],
    ["queued", "serve"],
    ["preparing", "serve"],
    ["ready", "start"],
    ["served", "start"],
    ["voided", "ready"],
  ] as const)("rejects %s -> %s", (from, action) => {
    expect(() => assertTransition(from, action)).toThrow(/Cannot/);
  });
  it("only queued items are editable", () => {
    expect(isEditable("queued")).toBe(true);
    expect(isEditable("preparing")).toBe(false);
  });
});

describe("deriveTicketStatus", () => {
  it("does not mark a ticket ready while any item is still cooking (partial readiness)", () => {
    expect(deriveTicketStatus(["ready", "preparing"])).toBe("preparing");
    expect(deriveTicketStatus(["ready", "queued"])).toBe("preparing");
    expect(deriveTicketStatus(["ready", "ready"])).toBe("ready");
  });
  it("derives new/served/voided and ignores voided items", () => {
    expect(deriveTicketStatus(["queued", "queued"])).toBe("new");
    expect(deriveTicketStatus(["served", "voided"])).toBe("served");
    expect(deriveTicketStatus(["ready", "served"])).toBe("ready");
    expect(deriveTicketStatus(["voided"])).toBe("voided");
  });
});
