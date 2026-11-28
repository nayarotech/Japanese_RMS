import express, { type NextFunction, type Request, type Response, Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../../../app/deps.js";
import { withTenantTransaction } from "../../../infrastructure/database/db.js";
import { Errors } from "../../../shared/errors/app-error.js";
import { parse } from "../../../shared/http/validate.js";
import { recordAudit } from "../../audit/index.js";
import { requirePermission } from "../../authorization/index.js";
import { requireFeature } from "../../entitlements/index.js";
import { staff } from "../../identity/http/middleware.js";
import {
  ACCEPTED_IMAGE_TYPES,
  IMAGE_CACHE_CONTROL,
  createProcessingGate,
  imageErrors,
} from "../../menus/images/index.js";
import {
  MAX_FEATURED_ITEMS,
  getStorefrontSettings,
  loadServableStorefrontImage,
  removeStorefrontImage,
  saveStorefrontSettings,
  setStorefrontImage,
} from "../index.js";

const text = (max: number) => z.string().max(max).nullable();
const Localized = (max: number) => z.strictObject({ ja: text(max), en: text(max) });

const SettingsBody = z.strictObject({
  version: z.int().min(0),
  displayName: text(60),
  description: Localized(300),
  announcement: Localized(200),
  phone: z
    .string()
    .trim()
    .regex(/^$|^[0-9+() -]{6,20}$/)
    .nullable(),
  address: Localized(200),
  accentColor: z
    .string()
    .trim()
    .regex(/^$|^#[0-9a-fA-F]{6}$/)
    .nullable(),
  featuredItemIds: z.array(z.uuid()).max(MAX_FEATURED_ITEMS),
});
const Kind = z.enum(["logo", "cover"]);

/** Staff-only storefront settings (mounted after the staff guard). */
export function storefrontRoutes(deps: AppDeps): Router {
  const r = Router();

  r.get("/storefront", async (req, res) => {
    const ctx = staff(req);
    requirePermission(ctx, "storefront.manage");
    const data = await withTenantTransaction(deps.db, ctx, (tx) =>
      getStorefrontSettings(tx, ctx.locationId, deps.storage),
    );
    res.setHeader("Cache-Control", "no-store");
    res.json(data);
  });

  r.put("/storefront", async (req, res) => {
    const ctx = staff(req);
    requirePermission(ctx, "storefront.manage");
    const body = parse(SettingsBody, req.body);
    const data = await withTenantTransaction(deps.db, ctx, async (tx) => {
      await requireFeature(tx, ctx.locationId, "dine_in_pos");
      await saveStorefrontSettings(tx, ctx, body);
      await recordAudit(tx, ctx, {
        action: "storefront.updated",
        targetType: "location",
        targetId: ctx.locationId,
        metadata: { featured: body.featuredItemIds.length },
      });
      return getStorefrontSettings(tx, ctx.locationId, deps.storage);
    });
    res.json(data);
  });

  const imageGate = createProcessingGate({ concurrency: 2, maxQueue: 8 });
  const maxBytes = deps.config.MENU_IMAGE_MAX_BYTES;
  const rawImage = express.raw({ type: [...ACCEPTED_IMAGE_TYPES], limit: maxBytes });
  // Authorize BEFORE reading the body (no buffering for unauthorized or rate-limited clients).
  const authorize = async (req: Request, _res: Response, next: NextFunction) => {
    const ctx = staff(req);
    requirePermission(ctx, "storefront.manage");
    await deps.limits.menuImageUploadPerSession(ctx.sessionId);
    next();
  };
  const readBody = (req: Request, res: Response, next: NextFunction) => {
    rawImage(req, res, (err?: unknown) => {
      if ((err as { type?: string } | undefined)?.type === "entity.too.large") {
        next(imageErrors.tooLarge(maxBytes));
        return;
      }
      next(err);
    });
  };

  r.put("/storefront/images/:kind", authorize, readBody, async (req, res) => {
    const ctx = staff(req);
    const kind = parse(Kind, req.params["kind"]);
    if (!Buffer.isBuffer(req.body)) throw imageErrors.unsupported();
    const result = await setStorefrontImage(deps, ctx, kind, req.body, imageGate);
    res.status(result.replaced ? 200 : 201).json({ image: result.image });
  });

  r.delete("/storefront/images/:kind", authorize, async (req, res) => {
    const ctx = staff(req);
    const kind = parse(Kind, req.params["kind"]);
    await removeStorefrontImage(deps, ctx, kind);
    res.status(204).end();
  });

  return r;
}

/** Public delivery of active storefront logos/covers (mounted BEFORE the generic menu media route). */
export function storefrontMediaRoutes(deps: AppDeps): Router {
  const r = Router();
  r.get("/public/media/storefront-images/*key", async (req, res) => {
    await deps.limits.mediaReadPerIp(req.ip ?? "unknown");
    const raw = (req.params as { key?: string | string[] }).key;
    const rest = Array.isArray(raw) ? raw.join("/") : (raw ?? "");
    const obj = await loadServableStorefrontImage(deps, `storefront-images/${rest}`);
    if (!obj) {
      res.setHeader("Cache-Control", "no-store");
      throw Errors.notFound("image");
    }
    res.setHeader("Content-Type", obj.contentType);
    res.setHeader("Cache-Control", IMAGE_CACHE_CONTROL);
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.send(obj.body);
  });
  return r;
}
