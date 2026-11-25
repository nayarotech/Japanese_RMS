/**
 * Menu item photos: upload, replace, remove, cleanup and public serving. One primary photo per item.
 *
 * Write order (never delete the old photo before the new one is durable and referenced):
 *   1. validate + re-encode in memory (bounded concurrency)
 *   2. tx: insert a `pending` row with fresh opaque keys                    (crash after this -> sweeper finds it)
 *   3. upload both renditions to object storage                             (failure -> delete what was written)
 *   4. tx: lock the item, retire the current photo, activate the new one    (failure -> delete the new objects)
 *   5. after commit: delete the retired photo's objects                     (failure -> stays `retired`, retried)
 *
 * No database transaction is held open during storage I/O.
 */
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import type { AppDeps } from "../../../app/deps.js";
import { type Tx, withTenantTransaction } from "../../../infrastructure/database/db.js";
import type { ObjectStorage } from "../../../infrastructure/storage/object-storage.js";
import { AppError, Errors } from "../../../shared/errors/app-error.js";
import type { StaffContext } from "../../../shared/types/access-context.js";
import { recordAudit } from "../../audit/index.js";
import { type ProcessedImage, processMenuImage } from "./processing.js";

export {
  ACCEPTED_IMAGE_TYPES,
  createProcessingGate,
  detectImageType,
  IMAGE_LIMITS,
  imageErrors,
  processMenuImage,
} from "./processing.js";

/** Delivery metadata for a menu item photo. Never contains binaries, storage credentials or bucket names. */
export interface MenuImageView {
  url: string;
  thumbUrl: string;
  width: number;
  height: number;
  thumbWidth: number;
  thumbHeight: number;
}

export function toImageView(
  storage: ObjectStorage,
  row: {
    storage_key: string;
    thumb_storage_key: string;
    width: number;
    height: number;
    thumb_width: number;
    thumb_height: number;
  },
): MenuImageView {
  return {
    url: storage.publicUrl(row.storage_key),
    thumbUrl: storage.publicUrl(row.thumb_storage_key),
    width: row.width,
    height: row.height,
    thumbWidth: row.thumb_width,
    thumbHeight: row.thumb_height,
  };
}

/** Objects are written once under a unique key, so they can be cached forever by browsers and CDNs. */
export const IMAGE_CACHE_CONTROL = "public, max-age=31536000, immutable";

// menu-images/<tenant uuid>/<22-char random>/<main|thumb>.webp (also enforced by a CHECK constraint).
const KEY_RE =
  /^menu-images\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[A-Za-z0-9_-]{22}\/(main|thumb)\.webp$/;

function newKeys(tenantId: string): { main: string; thumb: string } {
  const token = randomBytes(16).toString("base64url"); // 128 bits, 22 chars, unguessable
  const base = `menu-images/${tenantId}/${token}`;
  return { main: `${base}/main.webp`, thumb: `${base}/thumb.webp` };
}

/** Pending rows older than this are treated as abandoned by a crashed request. */
const PENDING_TIMEOUT_MINUTES = 15;
const SWEEP_BATCH = 20;

export interface ImageChangeResult {
  image: MenuImageView;
  replaced: boolean;
}

async function assertItemInLocation(tx: Tx, locationId: string, itemId: string, lock: boolean) {
  let q = tx
    .selectFrom("menu_items")
    .select("id")
    .where("id", "=", itemId)
    .where("location_id", "=", locationId);
  if (lock) q = q.forUpdate();
  // RLS limits this to the caller's tenant; the location filter limits it to the caller's branch.
  if (!(await q.executeTakeFirst())) throw Errors.notFound("menu item");
}

/**
 * Sets (adds or replaces) the photo of a menu item in the caller's location.
 * `run` bounds concurrent processing (see createProcessingGate).
 */
export async function setMenuItemImage(
  deps: AppDeps,
  ctx: StaffContext,
  itemId: string,
  input: Buffer,
  run: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<ImageChangeResult> {
  // Cheap existence check before spending CPU on processing.
  await withTenantTransaction(deps.db, ctx, (tx) =>
    assertItemInLocation(tx, ctx.locationId, itemId, false),
  );
  const processed: ProcessedImage = await run(() =>
    processMenuImage(input, { maxBytes: deps.config.MENU_IMAGE_MAX_BYTES }),
  );

  const keys = newKeys(ctx.tenantId);
  const pending = await withTenantTransaction(deps.db, ctx, async (tx) => {
    await assertItemInLocation(tx, ctx.locationId, itemId, false);
    return tx
      .insertInto("menu_item_images")
      .values({
        tenant_id: ctx.tenantId,
        location_id: ctx.locationId,
        menu_item_id: itemId,
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
      .executeTakeFirstOrThrow();
  });

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
    deps.logger.warn({ err, imageId: pending.id }, "menu image upload to storage failed");
    await abandonPending(deps, ctx.tenantId, pending.id);
    throw new AppError(503, "storage_unavailable", "Image storage is unavailable, please retry", {
      retryAfterSeconds: 10,
    });
  }

  let replaced: boolean;
  try {
    replaced = await withTenantTransaction(deps.db, ctx, async (tx) => {
      // Serialises concurrent photo changes for the same item.
      await assertItemInLocation(tx, ctx.locationId, itemId, true);
      const retired = await retireActive(tx, ctx.locationId, itemId);
      const activated = await tx
        .updateTable("menu_item_images")
        .set({ status: "active", activated_at: new Date() })
        .where("id", "=", pending.id)
        .where("status", "=", "pending") // lost to the sweeper -> fail rather than serve deleted objects
        .executeTakeFirst();
      if (activated.numUpdatedRows !== 1n)
        throw Errors.conflict("image_upload_expired", "Upload took too long, please retry");
      await recordAudit(tx, ctx, {
        action: retired > 0 ? "menu.item.image_replaced" : "menu.item.image_added",
        targetType: "menu_item",
        targetId: itemId,
        metadata: {
          imageId: pending.id,
          width: pending.width,
          height: pending.height,
          byteSize: pending.byte_size,
          sourceType: pending.source_content_type,
        },
      });
      return retired > 0;
    });
  } catch (err) {
    await abandonPending(deps, ctx.tenantId, pending.id);
    throw err;
  }

  // The new photo is committed and live; only now remove the previous one.
  await purgeRetiredImages(deps, ctx.tenantId);
  return { image: toImageView(deps.storage, pending), replaced };
}

/** Removes the photo of a menu item (idempotent). The item keeps working and shows its placeholder. */
export async function removeMenuItemImage(
  deps: AppDeps,
  ctx: StaffContext,
  itemId: string,
): Promise<{ removed: boolean }> {
  const removed = await withTenantTransaction(deps.db, ctx, async (tx) => {
    await assertItemInLocation(tx, ctx.locationId, itemId, true);
    const retired = await retireActive(tx, ctx.locationId, itemId);
    if (retired > 0) {
      await recordAudit(tx, ctx, {
        action: "menu.item.image_removed",
        targetType: "menu_item",
        targetId: itemId,
      });
    }
    return retired > 0;
  });
  if (removed) await purgeRetiredImages(deps, ctx.tenantId);
  return { removed };
}

async function retireActive(tx: Tx, locationId: string, itemId: string): Promise<number> {
  const res = await tx
    .updateTable("menu_item_images")
    .set({ status: "retired", retired_at: new Date() })
    .where("menu_item_id", "=", itemId)
    .where("location_id", "=", locationId)
    .where("status", "=", "active")
    .executeTakeFirst();
  return Number(res.numUpdatedRows);
}

/** A pending upload failed: retire it and try to delete whatever reached storage. Never throws. */
async function abandonPending(deps: AppDeps, tenantId: string, imageId: string): Promise<void> {
  try {
    await withTenantTransaction(deps.db, { tenantId }, (tx) =>
      tx
        .updateTable("menu_item_images")
        .set({ status: "retired", retired_at: new Date() })
        .where("id", "=", imageId)
        .where("status", "=", "pending")
        .execute(),
    );
    await purgeRetiredImages(deps, tenantId, { ids: [imageId] });
  } catch (err) {
    deps.logger.warn({ err, imageId }, "menu image cleanup deferred");
  }
}

/**
 * Deletes the objects of retired photos (and of pending uploads abandoned by a crash) for one tenant, then
 * tombstones the rows. Idempotent and safe to run concurrently. Failures leave rows `retired` for the next run.
 * Runs opportunistically after every photo change; see the architecture doc for the scheduled sweep.
 */
export async function purgeRetiredImages(
  deps: AppDeps,
  tenantId: string,
  opts: { ids?: string[] } = {},
): Promise<{ deleted: number; failed: number }> {
  const candidates = await withTenantTransaction(deps.db, { tenantId }, async (tx) => {
    // Claim abandoned pending rows atomically: an in-flight activation (`WHERE status = 'pending'`) and this
    // claim cannot both succeed, so objects of a live photo are never deleted.
    await tx
      .updateTable("menu_item_images")
      .set({ status: "retired", retired_at: new Date() })
      .where("status", "=", "pending")
      .where(
        "created_at",
        "<",
        sql<Date>`now() - make_interval(mins => ${PENDING_TIMEOUT_MINUTES})`,
      )
      .execute();
    let q = tx
      .selectFrom("menu_item_images")
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
          .updateTable("menu_item_images")
          .set({ status: "deleted", deleted_at: new Date() })
          .where("id", "=", row.id)
          .where("status", "=", "retired")
          .execute(),
      );
      deleted++;
    } catch (err) {
      failed++;
      deps.logger.warn({ err, imageId: row.id }, "menu image object deletion failed; will retry");
      await withTenantTransaction(deps.db, { tenantId }, (tx) =>
        tx
          .updateTable("menu_item_images")
          .set((eb) => ({ cleanup_attempts: eb("cleanup_attempts", "+", 1) }))
          .where("id", "=", row.id)
          .execute(),
      ).catch(() => undefined);
    }
  }
  return { deleted, failed };
}

/**
 * Resolves a public media key to its object, ONLY if it is the active photo of a menu item. Forged keys, keys of
 * another tenant, and replaced/removed photos all return null.
 */
export async function loadServableImage(
  deps: AppDeps,
  key: string,
): Promise<{ body: Buffer; contentType: string } | null> {
  const m = KEY_RE.exec(key);
  if (!m?.[1]) return null;
  const tenantId = m[1];
  const row = await withTenantTransaction(deps.db, { tenantId }, (tx) =>
    tx
      .selectFrom("menu_item_images")
      .select("id")
      .where("status", "=", "active")
      .where((eb) => eb.or([eb("storage_key", "=", key), eb("thumb_storage_key", "=", key)]))
      .executeTakeFirst(),
  );
  if (!row) return null;
  const obj = await deps.storage.get(key);
  if (!obj) {
    deps.logger.warn({ imageId: row.id }, "active menu image object missing from storage");
    return null;
  }
  return obj;
}
