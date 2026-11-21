/**
 * Ordering hours and pickup time slots, evaluated in the LOCATION's time zone. Pure functions (clock passed in).
 *
 * Rules:
 *  - Online ordering is accepted only while `now` is inside an ordering window ("open now").
 *  - Pickup slots start at each window's opening time, every `slotMinutes`, strictly before closing, and no earlier
 *    than `now + prepMinutes`. Slots for today and the next `daysAhead` days are offered.
 *  - The server regenerates the slots at submission; a requested time must be exactly one of them.
 *  - Windows never cross midnight (24:00 ends a day). No hours configured means closed (fail closed).
 */
export interface HoursWindow {
  weekday: number; // 0 = Sunday
  opensAt: string; // "HH:MM" or "HH:MM:SS"
  closesAt: string; // "24:00" allowed
}

const MAX_SLOTS = 300;

export function minutesOfDay(hhmm: string): number {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(hhmm);
  if (!m) throw new RangeError(`Invalid time ${hhmm}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) throw new RangeError(`Invalid time ${hhmm}`);
  return h * 60 + min;
}

export function formatMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  minutes: number;
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function localParts(instant: Date, timeZone: string): LocalParts {
  const parts = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  const year = Number(parts["year"]);
  const month = Number(parts["month"]);
  const day = Number(parts["day"]);
  const hour = Number(parts["hour"]) % 24;
  const minute = Number(parts["minute"]);
  return {
    year,
    month,
    day,
    minutes: hour * 60 + minute,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

/** Offset (ms) of `timeZone` from UTC at `instant`. */
function offsetMs(instant: number, timeZone: string): number {
  const p = formatterFor(timeZone)
    .formatToParts(new Date(instant))
    .reduce<Record<string, string>>((acc, x) => ({ ...acc, [x.type]: x.value }), {});
  const asUtc = Date.UTC(
    Number(p["year"]),
    Number(p["month"]) - 1,
    Number(p["day"]),
    Number(p["hour"]) % 24,
    Number(p["minute"]),
    Number(p["second"]),
  );
  return asUtc - (instant - (instant % 1000));
}

/** The UTC instant of a local wall-clock time (year/month/day + minutes after midnight) in `timeZone`. */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  minutes: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, 0, minutes);
  let result = guess - offsetMs(guess, timeZone);
  const corrected = guess - offsetMs(result, timeZone);
  if (corrected !== result) result = corrected; // crossed a DST boundary
  return new Date(result);
}

export function isOpenAt(windows: readonly HoursWindow[], now: Date, timeZone: string): boolean {
  const local = localParts(now, timeZone);
  return windows.some(
    (w) =>
      w.weekday === local.weekday &&
      minutesOfDay(w.opensAt) <= local.minutes &&
      local.minutes < minutesOfDay(w.closesAt),
  );
}

export function pickupSlots(args: {
  windows: readonly HoursWindow[];
  now: Date;
  timeZone: string;
  prepMinutes: number;
  slotMinutes: number;
  daysAhead: number;
}): Date[] {
  const earliest = args.now.getTime() + args.prepMinutes * 60_000;
  const today = localParts(args.now, args.timeZone);
  const slots: Date[] = [];
  for (let d = 0; d <= args.daysAhead && slots.length < MAX_SLOTS; d++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + d));
    const [y, m, day, weekday] = [
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      date.getUTCDay(),
    ];
    const windows = args.windows
      .filter((w) => w.weekday === weekday)
      .sort((a, b) => minutesOfDay(a.opensAt) - minutesOfDay(b.opensAt));
    for (const w of windows) {
      const close = minutesOfDay(w.closesAt);
      for (let t = minutesOfDay(w.opensAt); t < close; t += args.slotMinutes) {
        const instant = zonedToUtc(y, m, day, t, args.timeZone);
        if (instant.getTime() >= earliest) slots.push(instant);
        if (slots.length >= MAX_SLOTS) break;
      }
    }
  }
  return slots;
}

/** Validates a weekly schedule: sane times, no overlapping windows on the same weekday. */
export function validateWindows(windows: readonly HoursWindow[]): string | null {
  for (const w of windows) {
    if (!Number.isInteger(w.weekday) || w.weekday < 0 || w.weekday > 6) return "invalid_weekday";
    let open: number;
    let close: number;
    try {
      open = minutesOfDay(w.opensAt);
      close = minutesOfDay(w.closesAt);
    } catch {
      return "invalid_time";
    }
    if (close <= open) return "closes_before_opens";
  }
  for (let d = 0; d < 7; d++) {
    const day = windows
      .filter((w) => w.weekday === d)
      .map((w) => [minutesOfDay(w.opensAt), minutesOfDay(w.closesAt)] as const)
      .sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < day.length; i++) {
      const prev = day[i - 1];
      const cur = day[i];
      if (prev && cur && cur[0] < prev[1]) return "overlapping_windows";
    }
  }
  return null;
}
