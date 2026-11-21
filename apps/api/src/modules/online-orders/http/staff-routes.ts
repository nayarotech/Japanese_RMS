/**
 * Staff online-order API (behind requireStaff: session cookie, CSRF + Origin on mutations, staff rate limit).
 * Every route checks the PERMISSION (who) and the ENTITLEMENT (what the subscription includes) server-side.
 */
import { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../../../app/deps.js";
import { type Tx, withTenantTransaction } from "../../../infrastructure/database/db.js";
import {
  parseIdempotencyKey,
  withIdempotency,
} from "../../../infrastructure/database/idempotency.js";
import { parse } from "../../../shared/http/validate.js";
import type { StaffContext } from "../../../shared/types/access-context.js";
import { type Permission, requirePermission } from "../../authorization/index.js";
import { type FeatureKey, requireFeature, resolveEntitlements } from "../../entitlements/index.js";
import { staff } from "../../identity/http/middleware.js";
import {
  CANCELLATION_REASONS,
  REJECTION_REASONS,
  acceptOnlineOrder,
  cancelOnlineOrder,
  completePickup,
  deliverOnlineOrder,
  dispatchOnlineOrder,
  getOnlineOrderContact,
  getOnlineOrderDetail,
  listOnlineOrders,
  recordOnlinePayment,
  rejectOnlineOrder,
} from "../application/manage.js";
import {
  getHours,
  getOrCreateStoreLink,
  getSettings,
  getTiers,
  rotateStoreLink,
  saveSettings,
  setPaused,
} from "../application/settings.js";

const Id = z.uuid();
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/);
const Note = z
  .string()
  .trim()
  .max(300)
  .nullable()
  .transform((v) => (v ? v : null));

const SettingsBody = z.strictObject({
  version: z.int().min(0),
  settings: z.strictObject({
    enabled: z.boolean(),
    paused: z.boolean(),
    pickupEnabled: z.boolean(),
    deliveryEnabled: z.boolean(),
    payAtHandoverEnabled: z.boolean(),
    pickupPrepMinutes: z.int().min(5).max(240),
    pickupSlotMinutes: z.int().min(5).max(120),
    pickupDaysAhead: z.int().min(0).max(6),
    deliveryPrepMinutes: z.int().min(10).max(240),
    minOrderYen: z.int().min(0).max(1_000_000),
    storeLocation: z
      .strictObject({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
      })
      .nullable(),
    checkoutNote: z.strictObject({ ja: Note, en: Note }),
  }),
  hours: z
    .array(z.strictObject({ weekday: z.int().min(0).max(6), opensAt: HHMM, closesAt: HHMM }))
    .max(28),
  tiers: z
    .array(
      z.strictObject({
        maxDistanceM: z.int().min(100).max(50_000),
        feeYen: z.int().min(0).max(100_000),
        minOrderYen: z.int().min(0).max(1_000_000),
      }),
    )
    .max(10),
});

const RejectBody = z.strictObject({
  reason: z.enum(REJECTION_REASONS),
  note: z.string().trim().max(150).nullish(),
});
const CancelBody = z.strictObject({
  reason: z.enum(CANCELLATION_REASONS),
  note: z.string().trim().max(150).nullish(),
});
const Cash = z.int().min(0).max(10_000_000);
const PaymentBody = z.strictObject({ amountReceivedYen: Cash, expectedTotalYen: Cash });
const CompleteBody = z.strictObject({
  amountReceivedYen: Cash.optional(),
  expectedTotalYen: Cash.optional(),
});

export function onlineOrderStaffRoutes(deps: AppDeps): Router {
  const r = Router();

  /** Permission check, then a tenant transaction that re-checks the entitlement(s) before the use case. */
  const run = <T>(
    ctx: StaffContext,
    permission: Permission,
    features: FeatureKey[],
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> => {
    requirePermission(ctx, permission);
    return withTenantTransaction(deps.db, ctx, async (tx) => {
      for (const f of ["online_ordering" as const, ...features])
        await requireFeature(tx, ctx.locationId, f);
      return fn(tx);
    });
  };

  // ------------------------------------------------------------ settings

  const settingsView = async (tx: Tx, ctx: StaffContext) => {
    const [settings, hours, tiers, link, ent] = await Promise.all([
      getSettings(tx, ctx.locationId),
      getHours(tx, ctx.locationId),
      getTiers(tx, ctx.locationId),
      getOrCreateStoreLink(tx, ctx),
      resolveEntitlements(tx, ctx.locationId),
    ]);
    const { version, ...editable } = settings;
    return {
      version, // send back unchanged with PUT (optimistic concurrency)
      settings: editable,
      hours,
      tiers,
      link,
      features: {
        pickup: ent.features.has("pickup_ordering"),
        delivery: ent.features.has("delivery_management"),
      },
      geocoderEnabled: deps.geocoder.enabled,
    };
  };

  r.get("/online/settings", async (req, res) => {
    const ctx = staff(req);
    res.json(await run(ctx, "online_settings.manage", [], (tx) => settingsView(tx, ctx)));
  });

  r.put("/online/settings", async (req, res) => {
    const ctx = staff(req);
    const body = parse(SettingsBody, req.body);
    const extra: FeatureKey[] = [
      ...(body.settings.pickupEnabled ? (["pickup_ordering"] as const) : []),
      ...(body.settings.deliveryEnabled ? (["delivery_management"] as const) : []),
    ];
    res.json(
      await run(ctx, "online_settings.manage", extra, async (tx) => {
        await saveSettings(tx, ctx, body);
        return settingsView(tx, ctx);
      }),
    );
  });

  r.post("/online/link/rotate", async (req, res) => {
    const ctx = staff(req);
    res.json(await run(ctx, "online_settings.manage", [], (tx) => rotateStoreLink(tx, ctx)));
  });

  for (const [path, paused] of [
    ["/online/pause", true],
    ["/online/resume", false],
  ] as const) {
    r.post(path, async (req, res) => {
      const ctx = staff(req);
      await run(ctx, "online_orders.manage", [], (tx) => setPaused(tx, ctx, paused));
      res.status(204).end();
    });
  }

  // ------------------------------------------------------------ orders

  r.get("/online-orders", async (req, res) => {
    const ctx = staff(req);
    const scope = parse(z.enum(["active", "recent"]).default("active"), req.query["scope"]);
    res.json(
      await run(ctx, "online_orders.view", [], async (tx) => {
        const settings = await getSettings(tx, ctx.locationId);
        return {
          orders: await listOnlineOrders(tx, ctx.locationId, scope),
          ordering: { enabled: settings.enabled, paused: settings.paused },
        };
      }),
    );
  });

  r.get("/online-orders/:id", async (req, res) => {
    const ctx = staff(req);
    const id = parse(Id, req.params["id"]);
    res.json(await run(ctx, "online_orders.view", [], (tx) => getOnlineOrderDetail(tx, ctx, id)));
  });

  r.get("/online-orders/:id/contact", async (req, res) => {
    const ctx = staff(req);
    const id = parse(Id, req.params["id"]);
    res.setHeader("Cache-Control", "no-store");
    res.json(
      await run(ctx, "online_orders.contact_view", [], (tx) => getOnlineOrderContact(tx, ctx, id)),
    );
  });

  r.post("/online-orders/:id/accept", async (req, res) => {
    const ctx = staff(req);
    const id = parse(Id, req.params["id"]);
    parse(z.strictObject({}), req.body ?? {});
    res.json(await run(ctx, "online_orders.manage", [], (tx) => acceptOnlineOrder(tx, ctx, id)));
  });

  r.post("/online-orders/:id/reject", async (req, res) => {
    const ctx = staff(req);
    const id = parse(Id, req.params["id"]);
    const body = parse(RejectBody, req.body);
    res.json(
      await run(ctx, "online_orders.manage", [], (tx) => rejectOnlineOrder(tx, ctx, id, body)),
    );
  });

  r.post("/online-orders/:id/cancel", async (req, res) => {
    const ctx = staff(req);
    const id = parse(Id, req.params["id"]);
    const body = parse(CancelBody, req.body);
    // Pre-kitchen cancellation needs online_orders.manage; after cooking started, online_orders.cancel (managers).
    res.json(
      await run(ctx, "online_orders.manage", [], (tx) => cancelOnlineOrder(tx, ctx, id, body)),
    );
  });

  r.post("/online-orders/:id/dispatch", async (req, res) => {
    const ctx = staff(req);
    const id = parse(Id, req.params["id"]);
    res.json(
      await run(ctx, "online_orders.fulfill", ["delivery_management"], (tx) =>
        dispatchOnlineOrder(tx, ctx, id),
      ),
    );
  });

  r.post("/online-orders/:id/deliver", async (req, res) => {
    const ctx = staff(req);
    const id = parse(Id, req.params["id"]);
    res.json(
      await run(ctx, "online_orders.fulfill", ["delivery_management"], (tx) =>
        deliverOnlineOrder(tx, ctx, id),
      ),
    );
  });

  r.post("/online-orders/:id/complete", async (req, res) => {
    const ctx = staff(req);
    const id = parse(Id, req.params["id"]);
    const key = parseIdempotencyKey(req.header("idempotency-key"));
    const body = parse(CompleteBody, req.body);
    // Taking money as part of the handover needs the checkout permission as well.
    if (body.amountReceivedYen !== undefined) requirePermission(ctx, "checkout.perform");
    const result = await run(ctx, "online_orders.fulfill", ["pickup_ordering"], (tx) =>
      withIdempotency(
        tx,
        { tenantId: ctx.tenantId, scope: `online-complete:${id}`, key, request: body },
        async () => ({ status: 200, body: await completePickup(tx, ctx, id, body) }),
      ),
    );
    if (result.replayed) res.setHeader("Idempotent-Replayed", "true");
    res.status(result.status).json(result.body);
  });

  r.post("/online-orders/:id/payments/cash", async (req, res) => {
    const ctx = staff(req);
    const id = parse(Id, req.params["id"]);
    const key = parseIdempotencyKey(req.header("idempotency-key"));
    const body = parse(PaymentBody, req.body);
    const result = await run(ctx, "checkout.perform", [], (tx) =>
      withIdempotency(
        tx,
        { tenantId: ctx.tenantId, scope: `online-payment:${id}`, key, request: body },
        async () => ({ status: 201, body: await recordOnlinePayment(tx, ctx, id, body) }),
      ),
    );
    if (result.replayed) res.setHeader("Idempotent-Replayed", "true");
    res.status(result.status).json(result.body);
  });

  return r;
}
