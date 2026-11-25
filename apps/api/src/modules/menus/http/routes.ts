import express, { type NextFunction, type Request, type Response, Router } from "express";
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
import { Errors } from "../../../shared/errors/app-error.js";
import {
  ACCEPTED_IMAGE_TYPES,
  IMAGE_CACHE_CONTROL,
  createProcessingGate,
  imageErrors,
  loadServableImage,
  removeMenuItemImage,
  setMenuItemImage,
} from "../images/index.js";

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
      categories: await getMenu(tx, ctx.locationId, { publicView: false, storage: deps.storage }),
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

  // ---------------------------------------------------------------- photos (one primary photo per item)
  // At most 2 photos are re-encoded at once per API process (8 more may wait), so uploads cannot starve ordering.
  const imageGate = createProcessingGate({ concurrency: 2, maxQueue: 8 });
  const maxBytes = deps.config.MENU_IMAGE_MAX_BYTES;
  const rawImage = express.raw({ type: [...ACCEPTED_IMAGE_TYPES], limit: maxBytes });

  /** Authorise BEFORE the body is read, so unauthorised or rate-limited clients cannot make us buffer 5 MB. */
  const authorizeImageChange = async (req: Request, _res: Response, next: NextFunction) => {
    const ctx = staff(req);
    requirePermission(ctx, "menu.manage");
    await deps.limits.menuImageUploadPerSession(ctx.sessionId);
    next();
  };
  const readImageBody = (req: Request, res: Response, next: NextFunction) => {
    rawImage(req, res, (err?: unknown) => {
      if ((err as { type?: string } | undefined)?.type === "entity.too.large") {
        next(imageErrors.tooLarge(maxBytes));
        return;
      }
      next(err);
    });
  };

  // Body: the raw image bytes with Content-Type image/jpeg, image/png or image/webp (no multipart, no file name).
  r.put("/menu/items/:id/image", authorizeImageChange, readImageBody, async (req, res) => {
    const ctx = staff(req);
    const id = parse(Id, req.params["id"]);
    if (!Buffer.isBuffer(req.body)) throw imageErrors.unsupported();
    const result = await setMenuItemImage(deps, ctx, id, req.body, imageGate);
    res.status(result.replaced ? 200 : 201).json({ image: result.image });
  });

  r.delete("/menu/items/:id/image", authorizeImageChange, async (req, res) => {
    const ctx = staff(req);
    const id = parse(Id, req.params["id"]);
    await removeMenuItemImage(deps, ctx, id);
    res.status(204).end();
  });

  return r;
}

/**
 * Public, read-only delivery of menu photos when no CDN/public bucket URL is configured. Serves ONLY objects that are
 * the active photo of a menu item (checked against the database under that tenant's RLS context); never lists,
 * never writes, never exposes bucket names or credentials.
 */
export function menuMediaRoutes(deps: AppDeps): Router {
  const r = Router();
  r.get("/public/media/*key", async (req, res) => {
    await deps.limits.mediaReadPerIp(req.ip ?? "unknown");
    const raw = (req.params as { key?: string | string[] }).key;
    const key = Array.isArray(raw) ? raw.join("/") : (raw ?? "");
    const obj = await loadServableImage(deps, key);
    if (!obj) {
      res.setHeader("Cache-Control", "no-store");
      throw Errors.notFound("image");
    }
    res.setHeader("Content-Type", obj.contentType);
    res.setHeader("Cache-Control", IMAGE_CACHE_CONTROL);
    // Images may be embedded by the web app's own pages only (same origin, or the CDN in front of it).
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.send(obj.body);
  });
  return r;
}
