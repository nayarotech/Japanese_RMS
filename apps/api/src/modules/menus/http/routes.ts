import { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../../../app/deps.js";
import { withTenantTransaction } from "../../../infrastructure/database/db.js";
import { parse } from "../../../shared/http/validate.js";
import { recordAudit } from "../../audit/index.js";
import { requirePermission } from "../../authorization/index.js";
import { requireFeature } from "../../entitlements/index.js";
import { staff } from "../../identity/http/middleware.js";
import { listTaxRates } from "../../restaurants/index.js";
import {
  createCategory,
  createMenuItem,
  getMenu,
  setItemAvailability,
  updateMenuItem,
} from "../index.js";

const Id = z.uuid();
const ItemBody = z.strictObject({
  categoryId: z.uuid(),
  code: z.string().trim().max(20).nullish(),
  priceYen: z.int().min(0).max(10_000_000),
  taxRateId: z.uuid(),
  takeoutTaxRateId: z.uuid().nullish(),
  nameJa: z.string().trim().min(1).max(80),
  nameEn: z.string().trim().min(1).max(80).nullish(),
  descriptionJa: z.string().trim().max(300).nullish(),
  descriptionEn: z.string().trim().max(300).nullish(),
  sortOrder: z.int().min(0).max(100_000).optional(),
});

export function menuRoutes(deps: AppDeps): Router {
  const r = Router();

  r.get("/menu", async (req, res) => {
    const ctx = staff(req);
    requirePermission(ctx, "menu.view");
    const data = await withTenantTransaction(deps.db, ctx, async (tx) => ({
      categories: await getMenu(tx, ctx.locationId, { publicView: false }),
      taxRates: await listTaxRates(tx, ctx.locationId),
    }));
    res.json(data);
  });

  r.patch("/menu/items/:id/availability", async (req, res) => {
    const ctx = staff(req);
    requirePermission(ctx, "menu.manage");
    const id = parse(Id, req.params["id"]);
    const { isAvailable } = parse(z.strictObject({ isAvailable: z.boolean() }), req.body);
    await withTenantTransaction(deps.db, ctx, async (tx) => {
      await setItemAvailability(tx, ctx.locationId, id, isAvailable);
      await recordAudit(tx, ctx, {
        action: "menu.item.availability_changed",
        targetType: "menu_item",
        targetId: id,
        metadata: { isAvailable },
      });
    });
    res.status(204).end();
  });

  r.post("/menu/categories", async (req, res) => {
    const ctx = staff(req);
    requirePermission(ctx, "menu.manage");
    const body = parse(
      z.strictObject({
        nameJa: z.string().trim().min(1).max(60),
        nameEn: z.string().trim().min(1).max(60).nullish(),
        sortOrder: z.int().min(0).optional(),
      }),
      req.body,
    );
    const id = await withTenantTransaction(deps.db, ctx, async (tx) => {
      await requireFeature(tx, ctx.locationId, "dine_in_pos");
      const categoryId = await createCategory(tx, ctx.tenantId, ctx.locationId, body);
      await recordAudit(tx, ctx, {
        action: "menu.category.created",
        targetType: "menu_category",
        targetId: categoryId,
      });
      return categoryId;
    });
    res.status(201).json({ id });
  });

  r.post("/menu/items", async (req, res) => {
    const ctx = staff(req);
    requirePermission(ctx, "menu.manage");
    const body = parse(ItemBody, req.body);
    const id = await withTenantTransaction(deps.db, ctx, async (tx) => {
      await requireFeature(tx, ctx.locationId, "dine_in_pos");
      const itemId = await createMenuItem(tx, ctx.tenantId, ctx.locationId, body);
      await recordAudit(tx, ctx, {
        action: "menu.item.created",
        targetType: "menu_item",
        targetId: itemId,
        metadata: { priceYen: body.priceYen },
      });
      return itemId;
    });
    res.status(201).json({ id });
  });

  r.put("/menu/items/:id", async (req, res) => {
    const ctx = staff(req);
    requirePermission(ctx, "menu.manage");
    const id = parse(Id, req.params["id"]);
    const body = parse(
      ItemBody.extend({ version: z.int().min(1), isActive: z.boolean().optional() }),
      req.body,
    );
    await withTenantTransaction(deps.db, ctx, async (tx) => {
      await updateMenuItem(tx, ctx.tenantId, ctx.locationId, id, body.version, body);
      await recordAudit(tx, ctx, {
        action: "menu.item.updated",
        targetType: "menu_item",
        targetId: id,
        metadata: { priceYen: body.priceYen },
      });
    });
    res.status(204).end();
  });

  return r;
}
