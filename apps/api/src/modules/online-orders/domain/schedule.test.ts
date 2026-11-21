import { describe, expect, it } from "vitest";
import { isOpenAt, localParts, pickupSlots, validateWindows, zonedToUtc } from "./schedule.js";

const TZ = "Asia/Tokyo";
// Wednesday 2026-11-18 12:00 in Tokyo == 03:00 UTC.
const WED_NOON = new Date("2026-11-18T03:00:00Z");
const LUNCH_DINNER = [
  { weekday: 3, opensAt: "11:00", closesAt: "14:00" },
  { weekday: 3, opensAt: "17:00", closesAt: "22:00" },
  { weekday: 4, opensAt: "11:00", closesAt: "14:00" },
];

describe("time zone helpers", () => {
  it("converts Tokyo wall time to UTC and back", () => {
    expect(zonedToUtc(2026, 11, 18, 12 * 60, TZ).toISOString()).toBe("2026-11-18T03:00:00.000Z");
    expect(localParts(WED_NOON, TZ)).toMatchObject({ weekday: 3, minutes: 720, day: 18 });
  });

  it("handles a zone with daylight saving time", () => {
    // New York, 2026-07-01 09:00 EDT == 13:00 UTC.
    expect(zonedToUtc(2026, 7, 1, 9 * 60, "America/New_York").toISOString()).toBe(
      "2026-07-01T13:00:00.000Z",
    );
  });
});

describe("ordering hours", () => {
  it("is open inside a window and closed outside", () => {
    expect(isOpenAt(LUNCH_DINNER, WED_NOON, TZ)).toBe(true);
    expect(isOpenAt(LUNCH_DINNER, new Date("2026-11-18T06:30:00Z"), TZ)).toBe(false); // 15:30 JST
    expect(isOpenAt([], WED_NOON, TZ)).toBe(false); // no hours = closed (fail closed)
  });

  it("treats closing time as closed and 24:00 as the end of the day", () => {
    expect(isOpenAt(LUNCH_DINNER, new Date("2026-11-18T05:00:00Z"), TZ)).toBe(false); // 14:00 JST
    const allDay = [{ weekday: 3, opensAt: "00:00", closesAt: "24:00" }];
    expect(isOpenAt(allDay, new Date("2026-11-18T14:59:00Z"), TZ)).toBe(true); // 23:59 JST
  });

  it("rejects overlapping and inverted windows", () => {
    expect(validateWindows(LUNCH_DINNER)).toBeNull();
    expect(
      validateWindows([
        { weekday: 1, opensAt: "11:00", closesAt: "14:00" },
        { weekday: 1, opensAt: "13:00", closesAt: "15:00" },
      ]),
    ).toBe("overlapping_windows");
    expect(validateWindows([{ weekday: 1, opensAt: "14:00", closesAt: "11:00" }])).toBe(
      "closes_before_opens",
    );
  });
});

describe("pickup slots", () => {
  const slots = (prepMinutes: number, daysAhead = 0) =>
    pickupSlots({
      windows: LUNCH_DINNER,
      now: WED_NOON,
      timeZone: TZ,
      prepMinutes,
      slotMinutes: 15,
      daysAhead,
    });

  it("starts after the preparation time and stops before closing", () => {
    const s = slots(20).map((d) => d.toISOString());
    expect(s[0]).toBe("2026-11-18T03:30:00.000Z"); // 12:30 JST (12:15 < 12:20 is too early)
    expect(s).toContain("2026-11-18T04:45:00.000Z"); // 13:45 JST, last lunch slot
    expect(s).not.toContain("2026-11-18T05:00:00.000Z"); // 14:00 JST is closing time
    expect(s).toContain("2026-11-18T08:00:00.000Z"); // 17:00 JST dinner
  });

  it("offers the next day's slots only when configured", () => {
    expect(slots(20).some((d) => localParts(d, TZ).day === 19)).toBe(false);
    expect(slots(20, 1).some((d) => localParts(d, TZ).day === 19)).toBe(true);
  });
});
