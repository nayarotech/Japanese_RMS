/**
 * Public online-ordering API (no staff session). Mounted BEFORE the staff guard, so it can never reach staff APIs.
 * The shared `/public` per-IP read limiter (qr-ordering router) also applies to every route here.
 */
import { type Request, Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../../../app/deps.js";
import { parseIdempotencyKey } from "../../../infrastructure/database/idempotency.js";
import { Errors } from "../../../shared/errors/app-error.js";
import { parse } from "../../../shared/http/validate.js";
import { assertAllowedOrigin } from "../../identity/http/middleware.js";
import { OrderItemsBody } from "../../orders/index.js";
import {
  cancelByCustomer,
  getStorefront,
  getTrackingView,
  parseContactPhone,
  phoneRateKey,
  quoteOnlineOrder,
  submitOnlineOrder,
} from "../application/storefront.js";
import { authenticateTrackingToken } from "../application/tracking.js";

const StoreToken = z.string().regex(/^[A-Za-z0-9_-]{22,64}$/);
const Items = OrderItemsBody.shape.items;
const Fulfillment = z.enum(["pickup", "delivery"]);

const Address = z.strictObject({
  postalCode: z.string().trim().min(7).max(10),
  prefecture: z.string().trim().min(1).max(10),
  city: z.string().trim().min(1).max(60),
  line1: z.string().trim().min(1).max(120),
  line2: z.string().trim().max(120).nullish(),
  instructions: z.string().max(200).nullish(),
});

const QuoteBody = z.strictObject({
  fulfillmentType: Fulfillment,
  items: Items,
  address: Address.nullish(),
});

/** Prices, fees, distance and totals are NOT accepted (strict object: unknown fields are rejected with 400). */
const SubmitBody = z
  .strictObject({
    fulfillmentType: Fulfillment,
    items: Items,
    address: Address.nullish(),
    pickupTime: z.iso.datetime({ offset: true }).nullish(),
    contact: z.strictObject({
      name: z.string().trim().min(1).max(60),
      phone: z.string().trim().min(10).max(20),
      email: z.email().max(254).nullish(),
    }),
    paymentMethod: z.enum(["pay_on_pickup", "cash_on_delivery"]),
    expectedTotalYen: z.int().min(1).max(10_000_000),
  })
  .superRefine((b, ctx) => {
    if (b.fulfillmentType === "pickup" && !b.pickupTime)
      ctx.addIssue({ code: "custom", path: ["pickupTime"], message: "required for pickup" });
    if (b.fulfillmentType === "pickup" && b.address)
      ctx.addIssue({ code: "custom", path: ["address"], message: "not used for pickup" });
    if (b.fulfillmentType === "delivery" && !b.address)
      ctx.addIssue({ code: "custom", path: ["address"], message: "required for delivery" });
    if (b.fulfillmentType === "delivery" && b.pickupTime)
      ctx.addIssue({ code: "custom", path: ["pickupTime"], message: "not used for delivery" });
  });

const meta = (req: Request) => ({ ip: req.ip ?? null, requestId: req.requestId });

export function onlineOrderPublicRoutes(deps: AppDeps): Router {
  const r = Router();

  const customer = async (req: Request) => {
    await deps.limits.onlineTrackingPerIp(req.ip ?? "unknown");
    const c = await authenticateTrackingToken(deps.db, req.header("x-order-token"), meta(req));
    if (!c) throw Errors.unauthenticated();
    return c;
  };

  r.get("/public/stores/:token", async (req, res) => {
    const token = parse(StoreToken, req.params["token"]);
    res.setHeader("Cache-Control", "no-store");
    res.json(await getStorefront(deps, token));
  });

  r.post("/public/stores/:token/quote", async (req, res) => {
    assertAllowedOrigin(deps, req);
    const token = parse(StoreToken, req.params["token"]);
    const body = parse(QuoteBody, req.body);
    await deps.limits.onlineQuotePerIp(req.ip ?? "unknown");
    res.json(await quoteOnlineOrder(deps, token, body));
  });

  r.post("/public/stores/:token/orders", async (req, res) => {
    assertAllowedOrigin(deps, req);
    const token = parse(StoreToken, req.params["token"]);
    const key = parseIdempotencyKey(req.header("idempotency-key"));
    const body = parse(SubmitBody, req.body);
    // Anti-spam: per IP and per (hashed) phone number, before any database work.
    await deps.limits.onlineOrderPerIp(req.ip ?? "unknown");
    await deps.limits.onlineOrderPerPhone(phoneRateKey(parseContactPhone(body.contact.phone)));
    const { replayed, ...placed } = await submitOnlineOrder(deps, token, key, body, meta(req));
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json(placed);
  });

  r.get("/public/online-orders/current", async (req, res) => {
    const c = await customer(req);
    res.setHeader("Cache-Control", "no-store");
    res.json(await getTrackingView(deps, c));
  });

  r.post("/public/online-orders/current/cancel", async (req, res) => {
    assertAllowedOrigin(deps, req);
    const c = await customer(req);
    parse(z.strictObject({}), req.body ?? {});
    await cancelByCustomer(deps, c);
    res.status(204).end();
  });

  return r;
}
