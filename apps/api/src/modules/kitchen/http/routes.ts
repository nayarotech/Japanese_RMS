import { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../../../app/deps.js";
import { withTenantTransaction } from "../../../infrastructure/database/db.js";
import { parse } from "../../../shared/http/validate.js";
import { requirePermission } from "../../authorization/index.js";
import { requireFeature } from "../../entitlements/index.js";
import { staff } from "../../identity/http/middleware.js";
import {
  type KitchenTicketObserver,
  applyKitchenAction,
  isOnlineSource,
  listOpenTickets,
  listReadyItems,
} from "../index.js";

const Id = z.uuid();
const KitchenAction = z.enum(["start", "ready"]);

export interface KitchenHooks {
  /** Runs in the same transaction after a kitchen action on an ONLINE order's ticket (wired in app.ts). */
  afterOnlineTicketChange?: KitchenTicketObserver;
}

export function kitchenRoutes(deps: AppDeps, hooks: KitchenHooks = {}): Router {
  const r = Router();

  r.get("/kitchen/tickets", async (req, res) => {
    const ctx = staff(req);
    requirePermission(ctx, "kitchen.view");
    res.json({
      tickets: await withTenantTransaction(deps.db, ctx, async (tx) => {
        await requireFeature(tx, ctx.locationId, "kitchen_workflow");
        return listOpenTickets(tx, ctx.locationId);
      }),
    });
  });

  r.post("/kitchen/items/:id/:action", async (req, res) => {
    const ctx = staff(req);
    requirePermission(ctx, "kitchen.update");
    const id = parse(Id, req.params["id"]);
    const action = parse(KitchenAction, req.params["action"]);
    const ticket = await withTenantTransaction(deps.db, ctx, async (tx) => {
      await requireFeature(tx, ctx.locationId, "kitchen_workflow");
      const ticket = await applyKitchenAction(tx, ctx, action, { itemId: id });
      if (isOnlineSource(ticket.source)) await hooks.afterOnlineTicketChange?.(tx, ctx, ticket);
      return ticket;
    });
    res.json({ ticket });
  });

  r.post("/kitchen/tickets/:id/:action", async (req, res) => {
    const ctx = staff(req);
    requirePermission(ctx, "kitchen.update");
    const id = parse(Id, req.params["id"]);
    const action = parse(KitchenAction, req.params["action"]);
    const ticket = await withTenantTransaction(deps.db, ctx, async (tx) => {
      await requireFeature(tx, ctx.locationId, "kitchen_workflow");
      const ticket = await applyKitchenAction(tx, ctx, action, { ticketId: id });
      if (isOnlineSource(ticket.source)) await hooks.afterOnlineTicketChange?.(tx, ctx, ticket);
      return ticket;
    });
    res.json({ ticket });
  });

  /** Waiter reconciliation: everything ready and not yet served, straight from PostgreSQL. */
  r.get("/floor/ready-items", async (req, res) => {
    const ctx = staff(req);
    requirePermission(ctx, "floor.view");
    res.json({
      items: await withTenantTransaction(deps.db, ctx, async (tx) => {
        await requireFeature(tx, ctx.locationId, "kitchen_workflow");
        return listReadyItems(tx, ctx.locationId);
      }),
    });
  });

  r.post("/floor/items/:id/serve", async (req, res) => {
    const ctx = staff(req);
    requirePermission(ctx, "floor.serve");
    const id = parse(Id, req.params["id"]);
    const ticket = await withTenantTransaction(deps.db, ctx, async (tx) => {
      await requireFeature(tx, ctx.locationId, "kitchen_workflow");
      return applyKitchenAction(tx, ctx, "serve", { itemId: id });
    });
    res.json({ ticket });
  });

  r.post("/floor/tickets/:id/serve", async (req, res) => {
    const ctx = staff(req);
    requirePermission(ctx, "floor.serve");
    const id = parse(Id, req.params["id"]);
    const ticket = await withTenantTransaction(deps.db, ctx, async (tx) => {
      await requireFeature(tx, ctx.locationId, "kitchen_workflow");
      return applyKitchenAction(tx, ctx, "serve", { ticketId: id });
    });
    res.json({ ticket });
  });

  return r;
}
