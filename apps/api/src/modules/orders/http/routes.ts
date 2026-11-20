import { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../../../app/deps.js";
import { withTenantTransaction } from "../../../infrastructure/database/db.js";
import {
  parseIdempotencyKey,
  withIdempotency,
} from "../../../infrastructure/database/idempotency.js";
import { Errors } from "../../../shared/errors/app-error.js";
import { parse } from "../../../shared/http/validate.js";
import { requirePermission } from "../../authorization/index.js";
import { requireFeature } from "../../entitlements/index.js";
import { staff } from "../../identity/http/middleware.js";
import {
  MAX_NOTE_LENGTH,
  OrderItemsBody,
  editOrderItem,
  getBill,
  placeOrder,
  voidOrderItem,
} from "../index.js";

const Id = z.uuid();

export function orderRoutes(deps: AppDeps): Router {
  const r = Router();

  r.post("/sessions/:id/orders", async (req, res) => {
    const ctx = staff(req);
    requirePermission(ctx, "orders.create");
    const id = parse(Id, req.params["id"]);
    const key = parseIdempotencyKey(req.header("idempotency-key"));
    const body = parse(OrderItemsBody, req.body);
    const result = await withTenantTransaction(deps.db, ctx, async (tx) => {
      await requireFeature(tx, ctx.locationId, "dine_in_pos");
      return withIdempotency(
        tx,
        { tenantId: ctx.tenantId, scope: `staff-order:${id}`, key, request: body.items },
        async () => ({
          status: 201,
          body: await placeOrder(tx, ctx, id, body.items),
        }),
      );
    });
    if (result.replayed) res.setHeader("Idempotent-Replayed", "true");
    res.status(result.status).json(result.body);
  });

  r.patch("/order-items/:id", async (req, res) => {
    const ctx = staff(req);
    requirePermission(ctx, "orders.edit");
    const id = parse(Id, req.params["id"]);
    const body = parse(
      z
        .strictObject({
          version: z.int().min(1),
          quantity: z.int().min(1).max(99).optional(),
          note: z.string().max(MAX_NOTE_LENGTH).nullish(),
        })
        .refine(
          (b) => b.quantity !== undefined || b.note !== undefined,
          "quantity or note required",
        ),
      req.body,
    );
    await withTenantTransaction(deps.db, ctx, (tx) => editOrderItem(tx, ctx, id, body));
    res.status(204).end();
  });

  r.post("/order-items/:id/void", async (req, res) => {
    const ctx = staff(req);
    requirePermission(ctx, "orders.edit");
    const id = parse(Id, req.params["id"]);
    const { reason } = parse(
      z.strictObject({ reason: z.string().trim().min(1).max(200).nullish() }),
      req.body,
    );
    await withTenantTransaction(deps.db, ctx, (tx) => voidOrderItem(tx, ctx, id, reason ?? null));
    res.status(204).end();
  });

  r.get("/sessions/:id/bill", async (req, res) => {
    const ctx = staff(req);
    requirePermission(ctx, "tables.view");
    const id = parse(Id, req.params["id"]);
    res.json(
      await withTenantTransaction(deps.db, ctx, async (tx) => {
        await requireFeature(tx, ctx.locationId, "dine_in_pos");
        const exists = await tx
          .selectFrom("table_sessions")
          .select("id")
          .where("id", "=", id)
          .where("location_id", "=", ctx.locationId)
          .executeTakeFirst();
        if (!exists) throw Errors.notFound("table session");
        return getBill(tx, ctx.locationId, id);
      }),
    );
  });

  return r;
}
