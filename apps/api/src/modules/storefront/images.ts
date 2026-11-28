/**
 * Storefront logo and cover photo. Same pipeline and failure rules as menu photos (modules/menus/images):
 * validated and re-encoded to WebP (metadata stripped, SVG impossible), opaque tenant-prefixed keys, a pending row
 * before storage writes, activation only after both renditions are durable, old objects deleted after commit.
 */
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import type { AppDeps } from "../../app/deps.js";
import { type Tx, withTenantTransaction } from "../../infrastructure/database/db.js";
import type { StorefrontImageKind } from "../../infrastructure/database/schema.js";
import { AppError, Errors } from "../../shared/errors/app-error.js";
import type { StaffContext } from "../../shared/types/access-context.js";
import { recordAudit } from "../audit/index.js";
import {
  IMAGE_CACHE_CONTROL,
  type MenuImageView,
  processMenuImage,
  toImageView,
} from "../menus/images/index.js";

const KEY_RE =
  /^storefront-images\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[A-Za-z0-9_-]{22}\/(main|thumb)\.webp$/;
const PENDING_TIMEOUT_MINUTES = 15;
const SWEEP_BATCH = 20;

function newKeys(tenantId: string) {
  const base = `storefront-images/${tenantId}/${randomBytes(16).toString("base64url")}`;
  return { main: `${base}/main.webp`, thumb: `${base}/thumb.webp` };
}

export async function setStorefrontImage(
  deps: AppDeps,
  ctx: StaffContext,
  kind: StorefrontImageKind,
  input: Buffer,
  run: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<{ image: MenuImageView; replaced: boolean }> {
  const processed = await run(() =>
    processMenuImage(input, { maxBytes: deps.config.MENU_IMAGE_MAX_BYTES }),
  );
  const keys = newKeys(ctx.tenantId);
  const pending = await withTenantTransaction(deps.db, ctx, (tx) =>
    tx
      .insertInto("storefront_images")
      .values({
        tenant_id: ctx.tenantId,
        location_id: ctx.locationId,
        kind,
        storage_key: keys.main,
        thumb_storage_key: keys.thumb,
        content_type: "image/webp",
        width: processed.main.width,
        height: processed.main.height,
        byte_size: processed.main.byteSize,
        thumb_width: processed.thumb.width,
        thumb_height: processed.thumb.height,
        thumb_byte_size: processed.thumb.byteSize,
        source_content_type: processed.sourceType,
        source_byte_size: processed.sourceByteSize,
        uploaded_by: ctx.userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow(),
  );

  try {
    await Promise.all([
      deps.storage.put(keys.main, processed.main.body, {
        contentType: "image/webp",
        cacheControl: IMAGE_CACHE_CONTROL,
      }),
      deps.storage.put(keys.thumb, processed.thumb.body, {
        contentType: "image/webp",
        cacheControl: IMAGE_CACHE_CONTROL,
      }),
    ]);
  } catch (err) {
    deps.logger.warn({ err, imageId: pending.id }, "storefront image upload to storage failed");
    await abandon(deps, ctx.tenantId, pending.id);
    throw new AppError(503, "storage_unavailable", "Image storage is unavailable, please retry", {
      retryAfterSeconds: 10,
    });
  }

  let replaced: boolean;
  try {
    replaced = await withTenantTransaction(deps.db, ctx, async (tx) => {
      // Serialize concurrent changes of the same image kind for this branch.
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`storefront-image:${ctx.locationId}:${kind}`}))`.execute(
        tx,
      );
      const retired = await retire(tx, ctx, kind);
      const activated = await tx
        .updateTable("storefront_images")
        .set({ status: "active", activated_at: new Date() })
        .where("id", "=", pending.id)
        .where("status", "=", "pending")
        .executeTakeFirst();
      if (activated.numUpdatedRows !== 1n)
        throw Errors.conflict("image_upload_expired", "Upload took too long, please retry");
      await recordAudit(tx, ctx, {
        action: retired > 0 ? "storefront.image_replaced" : "storefront.image_added",
        targetType: "storefront_image",
        targetId: pending.id,
        metadata: { kind, width: pending.width, height: pending.height },
      });
      return retired > 0;
    });
  } catch (err) {
    await abandon(deps, ctx.tenantId, pending.id);
    throw err;
  }
  await purgeRetiredStorefrontImages(deps, ctx.tenantId);
  return { image: toImageView(deps.storage, pending), replaced };
}

export async function removeStorefrontImage(
  deps: AppDeps,
  ctx: StaffContext,
  kind: StorefrontImageKind,
): Promise<{ removed: boolean }> {
  const removed = await withTenantTransaction(deps.db, ctx, async (tx) => {
    const n = await retire(tx, ctx, kind);
    if (n > 0)
      await recordAudit(tx, ctx, {
        action: "storefront.image_removed",
        targetType: "storefront_image",
        metadata: { kind },
      });
    return n > 0;
  });
  if (removed) await purgeRetiredStorefrontImages(deps, ctx.tenantId);
  return { removed };
}

async function retire(tx: Tx, ctx: StaffContext, kind: StorefrontImageKind): Promise<number> {
  const res = await tx
    .updateTable("storefront_images")
    .set({ status: "retired", retired_at: new Date() })
    .where("location_id", "=", ctx.locationId)
    .where("kind", "=", kind)
    .where("status", "=", "active")
    .executeTakeFirst();
  return Number(res.numUpdatedRows);
}

async function abandon(deps: AppDeps, tenantId: string, imageId: string): Promise<void> {
  try {
    await withTenantTransaction(deps.db, { tenantId }, (tx) =>
      tx
        .updateTable("storefront_images")
        .set({ status: "retired", retired_at: new Date() })
        .where("id", "=", imageId)
        .where("status", "=", "pending")
        .execute(),
    );
    await purgeRetiredStorefrontImages(deps, tenantId, { ids: [imageId] });
  } catch (err) {
    deps.logger.warn({ err, imageId }, "storefront image cleanup deferred");
  }
}

/** Deletes objects of retired (and abandoned pending) storefront images for one tenant. Idempotent. */
export async function purgeRetiredStorefrontImages(
  deps: AppDeps,
  tenantId: string,
  opts: { ids?: string[] } = {},
): Promise<{ deleted: number; failed: number }> {
  const candidates = await withTenantTransaction(deps.db, { tenantId }, async (tx) => {
    await tx
      .updateTable("storefront_images")
      .set({ status: "retired", retired_at: new Date() })
      .where("status", "=", "pending")
      .where(
        "created_at",
        "<",
        sql<Date>`now() - make_interval(mins => ${PENDING_TIMEOUT_MINUTES})`,
      )
      .execute();
    let q = tx
      .selectFrom("storefront_images")
      .select(["id", "storage_key", "thumb_storage_key"])
      .where("status", "=", "retired")
      .orderBy("retired_at")
      .limit(SWEEP_BATCH);
    if (opts.ids) q = q.where("id", "in", opts.ids);
    return q.execute();
  });
  let deleted = 0;
  let failed = 0;
  for (const row of candidates) {
    try {
      await Promise.all([
        deps.storage.delete(row.storage_key),
        deps.storage.delete(row.thumb_storage_key),
      ]);
      await withTenantTransaction(deps.db, { tenantId }, (tx) =>
        tx
          .updateTable("storefront_images")
          .set({ status: "deleted", deleted_at: new Date() })
          .where("id", "=", row.id)
          .where("status", "=", "retired")
          .execute(),
      );
      deleted++;
    } catch (err) {
      failed++;
      deps.logger.warn({ err, imageId: row.id }, "storefront image deletion failed; will retry");
      await withTenantTransaction(deps.db, { tenantId }, (tx) =>
        tx
          .updateTable("storefront_images")
          .set((eb) => ({ cleanup_attempts: eb("cleanup_attempts", "+", 1) }))
          .where("id", "=", row.id)
          .execute(),
      ).catch(() => undefined);
    }
  }
  return { deleted, failed };
}

/** Serves a key ONLY if it is the active logo/cover of some branch (checked under that tenant's RLS context). */
export async function loadServableStorefrontImage(
  deps: AppDeps,
  key: string,
): Promise<{ body: Buffer; contentType: string } | null> {
  const m = KEY_RE.exec(key);
  if (!m?.[1]) return null;
  const tenantId = m[1];
  const row = await withTenantTransaction(deps.db, { tenantId }, (tx) =>
    tx
      .selectFrom("storefront_images")
      .select("id")
      .where("status", "=", "active")
      .where((eb) => eb.or([eb("storage_key", "=", key), eb("thumb_storage_key", "=", key)]))
      .executeTakeFirst(),
  );
  if (!row) return null;
  return deps.storage.get(key);
}
