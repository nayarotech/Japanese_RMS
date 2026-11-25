/**
 * Menu item photos end to end: upload/replace/remove over HTTP, validation, permissions, tenant isolation,
 * storage-failure cleanup, and the SAME photo reaching admin, POS, table QR and online ordering menus.
 */
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TenantFixture } from "../../src/infrastructure/database/fixtures.js";
import { purgeRetiredImages } from "../../src/modules/menus/images/index.js";
import { type StaffClient, idem, loginStaff } from "../helpers/clients.js";
import { type Harness, ORIGIN, TEST_PASSWORD, createHarness } from "../helpers/harness.js";

let h: Harness;
let A: TenantFixture; // standard plan with online ordering
let B: TenantFixture; // another restaurant
let managerA: StaffClient;
let ownerA: StaffClient;
let cashierA: StaffClient;
let waiterA: StaffClient;
let kitchenA: StaffClient;
let managerB: StaffClient;

const jpeg = (w = 1600, h2 = 1200) =>
  sharp({ create: { width: w, height: h2, channels: 3, background: { r: 180, g: 60, b: 30 } } })
    .jpeg()
    .toBuffer();
const png = () =>
  sharp({ create: { width: 640, height: 640, channels: 4, background: "#2a9d8f80" } })
    .png()
    .toBuffer();
const webp = () =>
  sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#e9c46a" } })
    .webp()
    .toBuffer();

function upload(c: StaffClient, itemId: string, body: Buffer, type = "image/jpeg") {
  return request(h.app)
    .put(`/api/v1/menu/items/${itemId}/image`)
    .set("Cookie", c.cookie)
    .set("Origin", ORIGIN)
    .set("X-CSRF-Token", c.csrf)
    .set("Content-Type", type)
    .send(body);
}
const media = (url: string) => request(h.app).get(url);

type ImageDto = {
  url: string;
  thumbUrl: string;
  width: number;
  height: number;
  thumbWidth: number;
  thumbHeight: number;
};
async function staffItem(c: StaffClient, itemId: string) {
  const res = await c.get("/menu");
  expect(res.status).toBe(200);
  const items = (
    res.body.categories as { items: { id: string; image: ImageDto | null }[] }[]
  ).flatMap((cat) => cat.items);
  return items.find((i) => i.id === itemId)!;
}
const imageRows = (f: TenantFixture, itemId: string) =>
  h.asTenant(f.tenantId, (tx) =>
    tx
      .selectFrom("menu_item_images")
      .selectAll()
      .where("menu_item_id", "=", itemId)
      .orderBy("created_at")
      .execute(),
  );
const keyOf = (url: string) => url.replace("/api/v1/public/media/", "");
const objectsOf = (f: TenantFixture) =>
  [...h.storage.objects.keys()].filter((k) => k.startsWith(`menu-images/${f.tenantId}/`));

beforeAll(async () => {
  h = await createHarness();
  [A, B] = await Promise.all([h.fixture({ planCode: "standard", online: true }), h.fixture()]);
  [managerA, ownerA, cashierA, waiterA, kitchenA, managerB] = await Promise.all([
    loginStaff(h.app, A.users.manager.email, TEST_PASSWORD),
    loginStaff(h.app, A.users.owner.email, TEST_PASSWORD),
    loginStaff(h.app, A.users.cashier.email, TEST_PASSWORD),
    loginStaff(h.app, A.users.waiter.email, TEST_PASSWORD),
    loginStaff(h.app, A.users.kitchen.email, TEST_PASSWORD),
    loginStaff(h.app, B.users.manager.email, TEST_PASSWORD),
  ]);
});
afterAll(async () => h.close());
beforeEach(() => {
  h.storage.failWith = null;
});

describe("valid uploads", () => {
  it("accepts a JPEG, stores web-ready renditions and returns delivery metadata only", async () => {
    const item = A.menu[0]!;
    const res = await upload(managerA, item.id, await jpeg(), "image/jpeg");
    expect(res.status).toBe(201);
    const img = res.body.image as ImageDto;
    expect(img.url).toMatch(
      /^\/api\/v1\/public\/media\/menu-images\/[0-9a-f-]{36}\/[A-Za-z0-9_-]{22}\/main\.webp$/,
    );
    expect(img.thumbUrl).toMatch(/\/thumb\.webp$/);
    expect([img.width, img.height]).toEqual([1200, 900]);
    expect([img.thumbWidth, img.thumbHeight]).toEqual([320, 240]);
    // No binaries, keys of other tenants, bucket names or credentials in the response.
    expect(JSON.stringify(res.body)).not.toMatch(/base64|bucket|secret|accessKey/i);
    expect((await staffItem(managerA, item.id)).image).toEqual(img);
  });

  it("accepts a PNG (owner) and a WebP", async () => {
    const a = await upload(ownerA, A.menu[1]!.id, await png(), "image/png");
    expect(a.status).toBe(201);
    expect([a.body.image.width, a.body.image.height]).toEqual([640, 640]);
    const b = await upload(managerA, A.menu[2]!.id, await webp(), "image/webp");
    expect(b.status).toBe(201);
    expect([b.body.image.width, b.body.image.height]).toEqual([1200, 600]);
  });

  it("trusts the content, not the declared type (PNG bytes labelled image/jpeg)", async () => {
    const res = await upload(managerA, A.menu[3]!.id, await png(), "image/jpeg");
    expect(res.status).toBe(201);
    const [row] = await imageRows(A, A.menu[3]!.id);
    expect(row!.source_content_type).toBe("image/png");
  });

  it("persists metadata (tenant, item, opaque keys, type, dimensions, sizes, uploader) and audits", async () => {
    const item = A.menu[0]!;
    const rows = await imageRows(A, item.id);
    const active = rows.filter((r) => r.status === "active");
    expect(active).toHaveLength(1);
    const row = active[0]!;
    expect(row).toMatchObject({
      tenant_id: A.tenantId,
      location_id: A.locationId,
      menu_item_id: item.id,
      content_type: "image/webp",
      width: 1200,
      height: 900,
      thumb_width: 320,
      thumb_height: 240,
      source_content_type: "image/jpeg",
      uploaded_by: A.users.manager.id,
    });
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.activated_at).toBeInstanceOf(Date);
    expect(row.storage_key.startsWith(`menu-images/${A.tenantId}/`)).toBe(true);
    expect(h.storage.objects.get(row.storage_key)!.body.length).toBe(row.byte_size);
    expect(h.storage.objects.get(row.thumb_storage_key)!.body.length).toBe(row.thumb_byte_size);
    const audit = await h.asTenant(A.tenantId, (tx) =>
      tx
        .selectFrom("audit_events")
        .select(["action", "actor_id"])
        .where("target_id", "=", item.id)
        .where("action", "like", "menu.item.image_%")
        .execute(),
    );
    expect(audit).toContainEqual({ action: "menu.item.image_added", actor_id: A.users.manager.id });
  });

  it("optimises: served renditions are WebP, size-bounded, smaller than the source and cacheable", async () => {
    const source = await sharp({
      create: {
        width: 2400,
        height: 1600,
        channels: 3,
        background: "#000",
        noise: { type: "gaussian", mean: 120, sigma: 35 },
      },
    })
      .jpeg({ quality: 85 })
      .toBuffer();
    const res = await upload(managerA, A.menu[4]!.id, source);
    expect(res.status).toBe(201);
    const main = await media(res.body.image.url);
    expect(main.status).toBe(200);
    expect(main.headers["content-type"]).toBe("image/webp");
    expect(main.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(main.headers["x-content-type-options"]).toBe("nosniff");
    const body = main.body as Buffer;
    const meta = await sharp(body).metadata();
    expect(meta.format).toBe("webp");
    expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(1200);
    expect(body.length).toBeLessThan(source.length);
    const thumb = await media(res.body.image.thumbUrl);
    expect(thumb.status).toBe(200);
    expect((thumb.body as Buffer).length).toBeLessThan(body.length);
  });
});

describe("rejected uploads", () => {
  it("unsupported file types (415), by content and by declared type", async () => {
    const gif = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#fff" } })
      .gif()
      .toBuffer();
    const id = A.menu[5]!.id;
    expect((await upload(managerA, id, gif, "image/gif")).status).toBe(415);
    const spoofed = await upload(managerA, id, gif, "image/jpeg");
    expect(spoofed.status).toBe(415);
    expect(spoofed.body.error.code).toBe("unsupported_image_type");
    const svg = await upload(managerA, id, Buffer.from("<svg onload=alert(1)/>"), "image/png");
    expect(svg.body.error.code).toBe("unsupported_image_type");
    expect((await upload(managerA, id, Buffer.from("hello"), "text/plain")).status).toBe(415);
    expect(await imageRows(A, id)).toHaveLength(0);
  });

  it("invalid image content with a valid signature (422)", async () => {
    const id = A.menu[5]!.id;
    const fake = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(4000)]);
    const res = await upload(managerA, id, fake, "image/jpeg");
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("invalid_image");
    expect(await imageRows(A, id)).toHaveLength(0);
  });

  it("oversized files (413) without processing", async () => {
    const id = A.menu[5]!.id;
    const big = Buffer.concat([await jpeg(), Buffer.alloc(5 * 1024 * 1024)]);
    const res = await upload(managerA, id, big, "image/jpeg");
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("image_too_large");
    expect(res.body.error.details.maxBytes).toBe(5 * 1024 * 1024);
    expect(await imageRows(A, id)).toHaveLength(0);
  });

  it("empty body (400)", async () => {
    const res = await upload(managerA, A.menu[5]!.id, Buffer.alloc(0), "image/jpeg");
    expect(res.status).toBe(400);
  });
});

describe("authorization and tenant isolation", () => {
  it("only menu managers (owner/manager) may change photos", async () => {
    const id = A.menu[5]!.id;
    const body = await jpeg(400, 300);
    for (const c of [cashierA, waiterA, kitchenA]) {
      const res = await upload(c, id, body);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
      expect((await c.del(`/menu/items/${id}/image`)).status).toBe(403);
    }
    const anon = await request(h.app)
      .put(`/api/v1/menu/items/${id}/image`)
      .set("Origin", ORIGIN)
      .set("Content-Type", "image/jpeg")
      .send(body);
    expect(anon.status).toBe(401);
    const noCsrf = await request(h.app)
      .put(`/api/v1/menu/items/${id}/image`)
      .set("Cookie", managerA.cookie)
      .set("Origin", ORIGIN)
      .set("Content-Type", "image/jpeg")
      .send(body);
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe("csrf_failed");
    const crossSite = await request(h.app)
      .put(`/api/v1/menu/items/${id}/image`)
      .set("Cookie", managerA.cookie)
      .set("Origin", "https://evil.example")
      .set("X-CSRF-Token", managerA.csrf)
      .set("Content-Type", "image/jpeg")
      .send(body);
    expect(crossSite.status).toBe(403);
    expect(await imageRows(A, id)).toHaveLength(0);
  });

  it("another restaurant's manager cannot add, replace or remove this restaurant's photos", async () => {
    const victim = A.menu[0]!;
    const before = await staffItem(managerA, victim.id);
    expect(before.image).not.toBeNull();
    const objectsBefore = objectsOf(A).length;

    const put = await upload(managerB, victim.id, await jpeg(500, 500));
    expect(put.status).toBe(404);
    const del = await managerB.del(`/menu/items/${victim.id}/image`);
    expect(del.status).toBe(404);

    expect((await staffItem(managerA, victim.id)).image).toEqual(before.image);
    expect(objectsOf(A)).toHaveLength(objectsBefore);
    expect(objectsOf(B)).toHaveLength(0);
    // B's own menu does not show A's photo.
    const bMenu = await managerB.get("/menu");
    expect(JSON.stringify(bMenu.body)).not.toContain(A.tenantId);
  });

  it("media keys cannot be manipulated to reach other objects", async () => {
    const img = (await staffItem(managerA, A.menu[0]!.id)).image!;
    expect((await media(img.url)).status).toBe(200);
    // Same opaque token under another tenant's prefix (RLS + key match) -> not found.
    expect((await media(img.url.replace(A.tenantId, B.tenantId))).status).toBe(404);
    for (const bad of [
      "/api/v1/public/media/menu-images/../../etc/passwd",
      "/api/v1/public/media/menu-images/%2e%2e%2f%2e%2e%2fsecret",
      `/api/v1/public/media/menu-images/${A.tenantId}/${"a".repeat(22)}/main.webp`,
      `/api/v1/public/media/menu-images/${A.tenantId}`,
      "/api/v1/public/media/other/thing.webp",
    ]) {
      expect((await media(bad)).status).toBe(404);
    }
  });
});

describe("replacement and removal", () => {
  it("replaces a photo: new one is live first, then the old objects are deleted", async () => {
    const id = A.menu[1]!.id;
    const old = (await staffItem(managerA, id)).image!;
    const res = await upload(managerA, id, await webp(), "image/webp");
    expect(res.status).toBe(200);
    expect(res.body.image.url).not.toBe(old.url);
    expect((await staffItem(managerA, id)).image).toEqual(res.body.image);

    const rows = await imageRows(A, id);
    expect(rows.filter((r) => r.status === "active")).toHaveLength(1);
    const oldRow = rows.find((r) => r.storage_key === keyOf(old.url))!;
    expect(oldRow.status).toBe("deleted");
    expect(oldRow.deleted_at).toBeInstanceOf(Date);
    expect(h.storage.objects.has(keyOf(old.url))).toBe(false);
    expect(h.storage.objects.has(keyOf(old.thumbUrl))).toBe(false);
    expect((await media(old.url)).status).toBe(404);
    expect((await media(res.body.image.url)).status).toBe(200);
  });

  it("concurrent replacements leave exactly one active photo and no leaked objects", async () => {
    const id = A.menu[2]!.id;
    const results = await Promise.all([
      upload(managerA, id, await jpeg(800, 800)),
      upload(ownerA, id, await jpeg(900, 600)),
      upload(managerA, id, await png(), "image/png"),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const rows = await imageRows(A, id);
    const active = rows.filter((r) => r.status === "active");
    expect(active).toHaveLength(1);
    expect(rows.filter((r) => r.status === "pending" || r.status === "retired")).toHaveLength(0);
    const live = new Set(
      (
        await h.asTenant(A.tenantId, (tx) =>
          tx
            .selectFrom("menu_item_images")
            .select(["storage_key", "thumb_storage_key"])
            .where("status", "=", "active")
            .execute(),
        )
      ).flatMap((r) => [r.storage_key, r.thumb_storage_key]),
    );
    expect(objectsOf(A).filter((k) => !live.has(k))).toEqual([]);
  });

  it("removes a photo: the item keeps working and shows the placeholder (image: null)", async () => {
    const id = A.menu[3]!.id;
    const old = (await staffItem(managerA, id)).image!;
    expect((await managerA.del(`/menu/items/${id}/image`)).status).toBe(204);
    const item = await staffItem(managerA, id);
    expect(item.image).toBeNull();
    expect(h.storage.objects.has(keyOf(old.url))).toBe(false);
    expect((await media(old.url)).status).toBe(404);
    // Idempotent, and the item is still orderable.
    expect((await managerA.del(`/menu/items/${id}/image`)).status).toBe(204);
    const session = await cashierA.post(`/tables/${A.tables[0]!.id}/sessions`, { guestCount: 1 });
    expect(session.status).toBe(201);
    const order = await cashierA.post(
      `/sessions/${session.body.session.id}/orders`,
      { items: [{ menuItemId: id, quantity: 1 }] },
      idem(),
    );
    expect(order.status).toBe(201);
    const audit = await h.asTenant(A.tenantId, (tx) =>
      tx
        .selectFrom("audit_events")
        .select("action")
        .where("target_id", "=", id)
        .where("action", "=", "menu.item.image_removed")
        .execute(),
    );
    expect(audit).toHaveLength(1);
  });

  it("returns 404 for unknown items", async () => {
    const res = await upload(
      managerA,
      "00000000-0000-7000-8000-000000000000",
      await jpeg(100, 100),
    );
    expect(res.status).toBe(404);
    expect((await managerA.del("/menu/items/not-a-uuid/image")).status).toBe(400);
  });
});

describe("storage failures and orphan cleanup", () => {
  it("a failed upload leaves no objects behind and keeps the existing photo untouched", async () => {
    const id = A.menu[4]!.id;
    const current = (await staffItem(managerA, id)).image!;
    const before = new Set(h.storage.objects.keys());
    h.storage.failWith = (op, key) =>
      op === "put" && key.endsWith("/thumb.webp") ? new Error("S3 down") : null;
    const res = await upload(managerA, id, await jpeg(700, 700));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("storage_unavailable");
    h.storage.failWith = null;

    expect(new Set(h.storage.objects.keys())).toEqual(before); // the half-written main rendition was removed
    expect((await staffItem(managerA, id)).image).toEqual(current);
    expect((await media(current.url)).status).toBe(200);
    const rows = await imageRows(A, id);
    expect(rows.filter((r) => r.status === "active")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "pending" || r.status === "retired")).toHaveLength(0);
  });

  it("if deleting the old objects fails, the replacement still succeeds and cleanup is retried later", async () => {
    const id = A.menu[4]!.id;
    const old = (await staffItem(managerA, id)).image!;
    h.storage.failWith = (op) => (op === "delete" ? new Error("S3 delete failed") : null);
    const res = await upload(managerA, id, await jpeg(600, 600));
    expect(res.status).toBe(200);
    h.storage.failWith = null;

    const oldRow = (await imageRows(A, id)).find((r) => r.storage_key === keyOf(old.url))!;
    expect(oldRow.status).toBe("retired");
    expect(oldRow.cleanup_attempts).toBeGreaterThan(0);
    expect(h.storage.objects.has(oldRow.storage_key)).toBe(true);
    expect((await media(old.url)).status).toBe(404); // no longer served even before cleanup

    const swept = await purgeRetiredImages(h.deps, A.tenantId);
    expect(swept.failed).toBe(0);
    expect(swept.deleted).toBeGreaterThanOrEqual(1);
    expect(h.storage.objects.has(oldRow.storage_key)).toBe(false);
    expect(h.storage.objects.has(oldRow.thumb_storage_key)).toBe(false);
    expect((await imageRows(A, id)).find((r) => r.id === oldRow.id)!.status).toBe("deleted");
  });

  it("sweeps uploads abandoned mid-way by a crash (stale pending rows), never live photos", async () => {
    const id = A.menu[5]!.id;
    const token = randomBytes(16).toString("base64url");
    const base = `menu-images/${A.tenantId}/${token}`;
    const opts = { contentType: "image/webp", cacheControl: "x" };
    await h.storage.put(`${base}/main.webp`, Buffer.from("x"), opts);
    await h.storage.put(`${base}/thumb.webp`, Buffer.from("x"), opts);
    const insert = (createdAt: Date, key: string) =>
      h.asTenant(A.tenantId, (tx) =>
        tx
          .insertInto("menu_item_images")
          .values({
            tenant_id: A.tenantId,
            location_id: A.locationId,
            menu_item_id: id,
            storage_key: `${key}/main.webp`,
            thumb_storage_key: `${key}/thumb.webp`,
            content_type: "image/webp",
            width: 10,
            height: 10,
            byte_size: 1,
            thumb_width: 10,
            thumb_height: 10,
            thumb_byte_size: 1,
            source_content_type: "image/jpeg",
            source_byte_size: 1,
            created_at: createdAt,
          })
          .returning("id")
          .executeTakeFirstOrThrow(),
      );
    const stale = await insert(new Date(Date.now() - 60 * 60_000), base);
    // A fresh pending row (an upload in progress right now) must not be touched.
    const freshBase = `menu-images/${A.tenantId}/${randomBytes(16).toString("base64url")}`;
    const fresh = await insert(new Date(), freshBase);
    const liveBefore = objectsOf(A).filter((k) => !k.startsWith(base));

    await purgeRetiredImages(h.deps, A.tenantId);
    const rows = await imageRows(A, id);
    expect(rows.find((r) => r.id === stale.id)!.status).toBe("deleted");
    expect(rows.find((r) => r.id === fresh.id)!.status).toBe("pending");
    expect(h.storage.objects.has(`${base}/main.webp`)).toBe(false);
    expect(objectsOf(A).filter((k) => !k.startsWith(base))).toEqual(liveBefore);
  });
});

describe("the same photo in every interface", () => {
  it("existing menu APIs keep working and keep the photo", async () => {
    const item = A.menu[0]!;
    const before = await staffItem(managerA, item.id);
    const full = (await managerA.get("/menu")).body.categories
      .flatMap((c: { items: unknown[] }) => c.items)
      .find((i: { id: string }) => i.id === item.id);
    const upd = await managerA.put(`/menu/items/${item.id}`, {
      categoryId: full.categoryId,
      code: full.code,
      priceYen: full.priceYen,
      taxRateId: full.taxRateId,
      takeoutTaxRateId: full.takeoutTaxRateId,
      nameJa: full.name.ja,
      nameEn: "Renamed",
      descriptionJa: full.description.ja,
      descriptionEn: full.description.en,
      sortOrder: full.sortOrder,
      version: full.version,
    });
    expect(upd.status).toBe(204);
    const avail = await managerA.patch(`/menu/items/${item.id}/availability`, {
      isAvailable: true,
    });
    expect(avail.status).toBe(204);
    const created = await managerA.post("/menu/items", {
      categoryId: full.categoryId,
      taxRateId: full.taxRateId,
      priceYen: 500,
      nameJa: "新商品",
    });
    expect(created.status).toBe(201);
    expect((await staffItem(managerA, created.body.id)).image).toBeNull();
    expect((await staffItem(managerA, item.id)).image).toEqual(before.image);
  });

  it("POS (staff menu for a cashier) shows the photo; items without one show the placeholder", async () => {
    const withPhoto = await staffItem(cashierA, A.menu[0]!.id);
    expect(withPhoto.image).toEqual((await staffItem(managerA, A.menu[0]!.id)).image);
    expect((await staffItem(cashierA, A.menu[3]!.id)).image).toBeNull();
    expect((await media(withPhoto.image!.thumbUrl)).status).toBe(200);
  });

  it("table QR menu shows the same photo (thumbnail URL available, no full original)", async () => {
    const staffImg = (await staffItem(managerA, A.menu[0]!.id)).image!;
    const res = await request(h.app).get(`/api/v1/public/tables/${A.tables[1]!.qrToken}`);
    expect(res.status).toBe(200);
    const items = res.body.menu.flatMap((c: { items: unknown[] }) => c.items);
    const item = items.find((i: { id: string }) => i.id === A.menu[0]!.id);
    expect(item.image).toEqual(staffImg);
    expect(items.find((i: { id: string }) => i.id === A.menu[3]!.id).image).toBeNull();
    const thumb = await media(item.image.thumbUrl);
    expect(thumb.status).toBe(200);
    const meta = await sharp(thumb.body as Buffer).metadata();
    expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(320);
  });

  it("online ordering storefront shows the same photo", async () => {
    const staffImg = (await staffItem(managerA, A.menu[0]!.id)).image!;
    const res = await request(h.app).get(`/api/v1/public/stores/${A.storeToken!}`);
    expect(res.status).toBe(200);
    const items = res.body.menu.flatMap((c: { items: unknown[] }) => c.items);
    expect(items.find((i: { id: string }) => i.id === A.menu[0]!.id).image).toEqual(staffImg);
    expect(items.find((i: { id: string }) => i.id === A.menu[3]!.id).image).toBeNull();
  });
});

describe("upload rate limit", () => {
  it("limits photo changes per staff session", async () => {
    const limited = await createHarness({
      limits: { menuImageUploadPerSession: { points: 2, durationSeconds: 60 } },
    });
    try {
      const c = await loginStaff(limited.app, A.users.manager.email, TEST_PASSWORD);
      const body = await jpeg(200, 200);
      const send = () =>
        request(limited.app)
          .put(`/api/v1/menu/items/${A.menu[6]?.id ?? A.menu[5]!.id}/image`)
          .set("Cookie", c.cookie)
          .set("Origin", ORIGIN)
          .set("X-CSRF-Token", c.csrf)
          .set("Content-Type", "image/jpeg")
          .send(body);
      expect([(await send()).status, (await send()).status]).toEqual([201, 200]);
      const third = await send();
      expect(third.status).toBe(429);
      expect(third.headers["retry-after"]).toBeDefined();
    } finally {
      await limited.close();
    }
  });
});
