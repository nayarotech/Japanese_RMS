import { describe, expect, it } from "vitest";
import { MAX_NOTE_LENGTH, normalizeNote } from "./notes.js";

describe("normalizeNote", () => {
  it("keeps ordinary instructions, including Japanese", () => {
    expect(normalizeNote("Less spicy")).toBe("Less spicy");
    expect(normalizeNote("ネギ抜き")).toBe("ネギ抜き");
  });
  it("returns null for empty or whitespace-only notes", () => {
    expect(normalizeNote("")).toBeNull();
    expect(normalizeNote("   \n\t ")).toBeNull();
    expect(normalizeNote(undefined)).toBeNull();
  });
  it("strips control and bidi/zero-width characters and collapses whitespace", () => {
    expect(normalizeNote("No\u0000 onion\n\nplease")).toBe("No onion please");
    expect(normalizeNote("extra‮noodles​")).toBe("extra noodles");
  });
  it("keeps HTML as inert text (escaping happens at render time)", () => {
    expect(normalizeNote("<script>alert(1)</script>")).toBe("<script>alert(1)</script>");
  });
  it("caps length by characters", () => {
    expect(Array.from(normalizeNote("あ".repeat(500)) ?? "").length).toBe(MAX_NOTE_LENGTH);
  });
});
