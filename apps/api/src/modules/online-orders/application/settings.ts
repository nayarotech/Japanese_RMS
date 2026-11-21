/**
 * Online ordering settings: one row per location + weekly hours + delivery fee tiers + the public storefront link.
 * Tenant- and location-scoped (RLS + explicit location filter). Changing settings never touches entitlements.
 */
import type { Db, Tx } from "../../../infrastructure/database/db.js";
import { newQrToken } from "../../../infrastructure/security/tokens.js";
import { Errors } from "../../../shared/errors/app-error.js";
import type { StaffContext } from "../../../shared/types/access-context.js";
import { recordAudit } from "../../audit/index.js";
import { type FeeTier, validateTiers } from "../domain/delivery.js";
import {
  type HoursWindow,
  formatMinutes,
  minutesOfDay,
  validateWindows,
} from "../domain/schedule.js";

export interface OnlineSettings {
  enabled: boolean;
  paused: boolean;
  pickupEnabled: boolean;
  deliveryEnabled: boolean;
  payAtHandoverEnabled: boolean;
  pickupPrepMinutes: number;
  pickupSlotMinutes: number;
  pickupDaysAhead: number;
  deliveryPrepMinutes: number;
  minOrderYen: number;
  storeLocation: { latitude: number; longitude: number } | null;
  checkoutNote: { ja: string | null; en: string | null };
  /** 0 = never saved (defaults shown). Optimistic concurrency token for updates. */
  version: number;
}

export const DEFAULT_SETTINGS: OnlineSettings = {
  enabled: false,
  paused: false,
  pickupEnabled: true,
  deliveryEnabled: false,
  payAtHandoverEnabled: true,
  pickupPrepMinutes: 20,
  pickupSlotMinutes: 15,
  pickupDaysAhead: 0,
  deliveryPrepMinutes: 40,
  minOrderYen: 0,
  storeLocation: null,
  checkoutNote: { ja: null, en: null },
  version: 0,
};

export async function getSettings(tx: Tx, locationId: string): Promise<OnlineSettings> {
  const r = await tx
    .selectFrom("online_ordering_settings")
    .selectAll()
    .where("location_id", "=", locationId)
    .executeTakeFirst();
  if (!r) return DEFAULT_SETTINGS;
  return {
    enabled: r.is_enabled,
    paused: r.is_paused,
    pickupEnabled: r.pickup_enabled,
    deliveryEnabled: r.delivery_enabled,
    payAtHandoverEnabled: r.pay_at_handover_enabled,
    pickupPrepMinutes: r.pickup_prep_minutes,
    pickupSlotMinutes: r.pickup_slot_minutes,
    pickupDaysAhead: r.pickup_days_ahead,
    deliveryPrepMinutes: r.delivery_prep_minutes,
    minOrderYen: r.min_order_yen,
    storeLocation:
      r.store_latitude !== null && r.store_longitude !== null
        ? { latitude: r.store_latitude, longitude: r.store_longitude }
        : null,
    checkoutNote: { ja: r.checkout_note_ja, en: r.checkout_note_en },
    version: r.version,
  };
}

export async function getHours(tx: Tx, locationId: string): Promise<HoursWindow[]> {
  const rows = await tx
    .selectFrom("online_ordering_hours")
    .select(["weekday", "opens_at", "closes_at"])
    .where("location_id", "=", locationId)
    .orderBy("weekday")
    .orderBy("opens_at")
    .execute();
  return rows.map((r) => ({
    weekday: r.weekday,
    opensAt: formatMinutes(minutesOfDay(r.opens_at)),
    closesAt: formatMinutes(minutesOfDay(r.closes_at)),
  }));
}

export async function getTiers(tx: Tx, locationId: string): Promise<FeeTier[]> {
  const rows = await tx
    .selectFrom("delivery_fee_tiers")
    .select(["max_distance_m", "fee_yen", "min_order_yen"])
    .where("location_id", "=", locationId)
    .orderBy("max_distance_m")
    .execute();
  return rows.map((r) => ({
    maxDistanceM: r.max_distance_m,
    feeYen: r.fee_yen,
    minOrderYen: r.min_order_yen,
  }));
}

export type SettingsInput = Omit<OnlineSettings, "version">;

/**
 * Saves settings, hours and tiers atomically (one "Save changes"). `version` must match what the manager loaded,
 * so two managers editing at once cannot silently overwrite each other.
 */
export async function saveSettings(
  tx: Tx,
  ctx: StaffContext,
  input: { version: number; settings: SettingsInput; hours: HoursWindow[]; tiers: FeeTier[] },
): Promise<OnlineSettings> {
  const hoursProblem = validateWindows(input.hours);
  if (hoursProblem) throw Errors.unprocessable("invalid_hours", hoursProblem);
  const tierProblem = validateTiers(input.tiers);
  if (tierProblem) throw Errors.unprocessable("invalid_delivery_tiers", tierProblem);
  const s = input.settings;
  if (s.deliveryEnabled && (s.storeLocation === null || input.tiers.length === 0)) {
    throw Errors.unprocessable(
      "delivery_not_configured",
      "Delivery needs the store location and at least one delivery distance tier",
    );
  }

  const before = await getSettings(tx, ctx.locationId);
  const values = {
    is_enabled: s.enabled,
    is_paused: s.paused,
    pickup_enabled: s.pickupEnabled,
    delivery_enabled: s.deliveryEnabled,
    pay_at_handover_enabled: s.payAtHandoverEnabled,
    pickup_prep_minutes: s.pickupPrepMinutes,
    pickup_slot_minutes: s.pickupSlotMinutes,
    pickup_days_ahead: s.pickupDaysAhead,
    delivery_prep_minutes: s.deliveryPrepMinutes,
    min_order_yen: s.minOrderYen,
    store_latitude: s.storeLocation?.latitude ?? null,
    store_longitude: s.storeLocation?.longitude ?? null,
    checkout_note_ja: s.checkoutNote.ja,
    checkout_note_en: s.checkoutNote.en,
    updated_at: new Date(),
    updated_by: ctx.userId,
  };
  if (input.version === 0) {
    const inserted = await tx
      .insertInto("online_ordering_settings")
      .values({ tenant_id: ctx.tenantId, location_id: ctx.locationId, ...values })
      .onConflict((oc) => oc.column("location_id").doNothing())
      .returning("location_id")
      .executeTakeFirst();
    if (!inserted) throw settingsConflict();
  } else {
    const res = await tx
      .updateTable("online_ordering_settings")
      .set((eb) => ({ ...values, version: eb("version", "+", 1) }))
      .where("location_id", "=", ctx.locationId)
      .where("version", "=", input.version)
      .executeTakeFirst();
    if (res.numUpdatedRows === 0n) throw settingsConflict();
  }

  await tx.deleteFrom("online_ordering_hours").where("location_id", "=", ctx.locationId).execute();
  if (input.hours.length > 0) {
    await tx
      .insertInto("online_ordering_hours")
      .values(
        input.hours.map((h) => ({
          tenant_id: ctx.tenantId,
          location_id: ctx.locationId,
          weekday: h.weekday,
          opens_at: h.opensAt,
          closes_at: h.closesAt === "24:00" ? "24:00:00" : h.closesAt,
        })),
      )
      .execute();
  }
  await tx.deleteFrom("delivery_fee_tiers").where("location_id", "=", ctx.locationId).execute();
  if (input.tiers.length > 0) {
    await tx
      .insertInto("delivery_fee_tiers")
      .values(
        input.tiers.map((t) => ({
          tenant_id: ctx.tenantId,
          location_id: ctx.locationId,
          max_distance_m: t.maxDistanceM,
          fee_yen: t.feeYen,
          min_order_yen: t.minOrderYen,
        })),
      )
      .execute();
  }
  const after = await getSettings(tx, ctx.locationId);
  await recordAudit(tx, ctx, {
    action: "online_settings.updated",
    targetType: "location",
    targetId: ctx.locationId,
    metadata: {
      changed: changedKeys(before, after),
      hours: input.hours.length,
      tiers: input.tiers.length,
    },
  });
  return after;
}

const settingsConflict = () =>
  Errors.conflict("version_conflict", "Online ordering settings were changed by someone else");

function changedKeys(a: OnlineSettings, b: OnlineSettings): string[] {
  return (Object.keys(a) as (keyof OnlineSettings)[]).filter(
    (k) => k !== "version" && JSON.stringify(a[k]) !== JSON.stringify(b[k]),
  );
}

/** Pause/resume new orders (operational, for a rush or a break). Does not change any other setting. */
export async function setPaused(tx: Tx, ctx: StaffContext, paused: boolean): Promise<void> {
  const res = await tx
    .updateTable("online_ordering_settings")
    .set((eb) => ({
      is_paused: paused,
      version: eb("version", "+", 1),
      updated_at: new Date(),
      updated_by: ctx.userId,
    }))
    .where("location_id", "=", ctx.locationId)
    .executeTakeFirst();
  if (res.numUpdatedRows === 0n)
    throw Errors.conflict("online_ordering_not_configured", "Set up online ordering first");
  await recordAudit(tx, ctx, {
    action: paused ? "online_ordering.paused" : "online_ordering.resumed",
    targetType: "location",
    targetId: ctx.locationId,
  });
}

// ---------------------------------------------------------------- public storefront link

export async function getOrCreateStoreLink(
  tx: Tx,
  ctx: StaffContext,
): Promise<{ token: string; issuedAt: Date }> {
  const row = await tx
    .selectFrom("online_store_links")
    .select(["token", "issued_at"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("location_id", "=", ctx.locationId)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  if (row) return { token: row.token, issuedAt: row.issued_at };
  const token = newQrToken();
  await tx
    .insertInto("online_store_links")
    .values({ token, tenant_id: ctx.tenantId, location_id: ctx.locationId })
    .execute();
  return { token, issuedAt: new Date() };
}

/** Reissue: the old shared link stops working immediately (e.g. it was posted somewhere it should not be). */
export async function rotateStoreLink(tx: Tx, ctx: StaffContext): Promise<{ token: string }> {
  await tx
    .updateTable("online_store_links")
    .set({ revoked_at: new Date() })
    .where("tenant_id", "=", ctx.tenantId)
    .where("location_id", "=", ctx.locationId)
    .where("revoked_at", "is", null)
    .execute();
  const token = newQrToken();
  await tx
    .insertInto("online_store_links")
    .values({ token, tenant_id: ctx.tenantId, location_id: ctx.locationId })
    .execute();
  await recordAudit(tx, ctx, {
    action: "online_store_link.rotated",
    targetType: "location",
    targetId: ctx.locationId,
  });
  return { token };
}

const STORE_TOKEN = /^[A-Za-z0-9_-]{22,64}$/;

/** Public resolution of a storefront link (no tenant context yet). */
export async function resolveStoreLink(
  db: Db,
  token: string,
): Promise<{ tenantId: string; locationId: string } | null> {
  if (!STORE_TOKEN.test(token)) return null;
  const row = await db
    .selectFrom("online_store_links")
    .select(["tenant_id", "location_id"])
    .where("token", "=", token)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  return row ? { tenantId: row.tenant_id, locationId: row.location_id } : null;
}
