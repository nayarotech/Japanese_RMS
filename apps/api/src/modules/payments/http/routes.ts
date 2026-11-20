import { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../../../app/deps.js";
import { withTenantTransaction } from "../../../infrastructure/database/db.js";
import {
  parseIdempotencyKey,
  withIdempotency,
} from "../../../infrastructure/database/idempotency.js";
import { parse } from "../../../shared/http/validate.js";
import { requirePermission } from "../../authorization/index.js";
import { requireFeature } from "../../entitlements/index.js";
import { staff } from "../../identity/http/middleware.js";
import { MAX_CASH_RECEIVED_YEN, checkoutCash, closeEmptySession, getReceipt } from "../index.js";

const Id = z.uuid();
const CashBody = z.strictObject({
  amountReceivedYen: z.int().min(0).max(MAX_CASH_RECEIVED_YEN),
  expectedTotalYen: z.int().min(1).max(MAX_CASH_RECEIVED_YEN),
});

export function paymentRoutes(deps: AppDeps): Router {
  const r = Router();

  r.post("/sessions/:id/checkout/cash", async (req, res) => {
    const ctx = staff(req);
    requirePermission(ctx, "checkout.perform");
    const id = parse(Id, req.params["id"]);
    const key = parseIdempotencyKey(req.header("idempotency-key"));
    const body = parse(CashBody, req.body);
    const result = await withTenantTransaction(deps.db, ctx, async (tx) => {
      await requireFeature(tx, ctx.locationId, "cash_checkout");
      return withIdempotency(
        tx,
        { tenantId: ctx.tenantId, scope: `checkout:${id}`, key, request: body },
        async () => ({
          status: 201,
          body: await checkoutCash(tx, ctx, id, body),
        }),
      );
    });
    if (result.replayed) res.setHeader("Idempotent-Replayed", "true");
    res.status(result.status).json(result.body);
  });

  r.post("/sessions/:id/close", async (req, res) => {
    const ctx = staff(req);
    requirePermission(ctx, "sessions.manage");
    const id = parse(Id, req.params["id"]);
    await withTenantTransaction(deps.db, ctx, (tx) => closeEmptySession(tx, ctx, id));
    res.status(204).end();
  });

  r.get("/receipts/:id", async (req, res) => {
    const ctx = staff(req);
    requirePermission(ctx, "receipts.view");
    const id = parse(Id, req.params["id"]);
    res.json(await withTenantTransaction(deps.db, ctx, (tx) => getReceipt(tx, ctx.locationId, id)));
  });

  return r;
}
