/**
 * Storefront settings and the customer-facing data built on them: permissions, validation, optimistic concurrency,
 * featured items, logo/cover images through the safe image pipeline, tenant isolation, the public storefront/QR/
 * tracking views, and the dine-in running bill (own session only).
 */
import sharp from "sharp";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantFixture } from "../../src/infrastructure/database/fixtures.js";
import { type StaffClient, joinAsGuest, loginStaff } from "../helpers/clients.js";
import { type Harness, ORIGIN, TEST_PASSWORD, createHarness } from "../helpers/harness.js";
import { storefront } from "../helpers/online.js";

let h: Harness;
let A: TenantFixture;
let B: TenantFixture;
let managerA: StaffClient;
let cashierA: StaffClient;
let managerB: StaffClient;

const empty = { ja: null, en: null };
const body = (version: number, patch: Record<string, unknown> = {}) => ({
  version,
  displayName: "Tokyo Sushi House",
  description: { ja: "旬のネタを握ります。", en: "Seasonal nigiri." },
  announcement: { ja: "年末年始は休業します。", en: null },
  phone: "03-1234-5678",
  address: { ja: "東京都渋谷区神南", en: "Jinnan, Shibuya" },
  accentColor: "#1d4ed8",
  featuredItemIds: [],
  ...patch,
});
const jpeg = () =>
  sharp({ create: { width: 1600, height: 700, channels: 3, background: "#7a4a2a" } })
    .jpeg()
    .toBuffer();
const uploadImage = (c: StaffClient, kind: string, buf: Buffer) =>
  request(h.app)
    .put(`/api/v1/storefront/images/${kind}`)
    .set("Cookie", c.cookie)
    .set("Origin", ORIGIN)
    .set("X-CSRF-Token", c.csrf)
    .set("Content-Type", "image/jpeg")
    .send(buf);

beforeAll(async () => {
  h = await createHarness();
  [A, B] = await Promise.all([
    h.fixture({ planCode: "standard", online: true }),
    h.fixture({ planCode: "standard", online: true }),
  ]);
  [managerA, cashierA, managerB] = await Promise.all([
    loginStaff(h.app, A.users.manager.email, TEST_PASSWORD),
    loginStaff(h.app, A.users.cashier.email, TEST_PASSWORD),
    loginStaff(h.app, B.users.manager.email, TEST_PASSWORD),
  ]);
});
afterAll(async () => h.close());

describe("storefront settings", () => {
  it("starts empty (version 0) and the public pages fall back to the location name", async () => {
    const res = await managerA.get("/storefront");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: 0,
      featuredItemIds: [],
      profile: { displayName: null, logo: null, cover: null, description: empty },
    });
    const store = await storefront(h.app, A.storeToken!).store();
    expect(store.body.profile.displayName).toBeNull();
    expect(store.body.featuredItemIds).toEqual([]);
  });

  it("requires storefront.manage", async () => {
    expect((await cashierA.get("/storefront")).status).toBe(403);
    expect((await cashierA.put("/storefront", body(0))).status).toBe(403);
    expect((await uploadImage(cashierA, "logo", await jpeg())).status).toBe(403);
  });

  it("validates input: strict body, accent contrast, featured items of this menu only, max 8", async () => {
    expect((await managerA.put("/storefront", { ...body(0), extra: 1 })).status).toBe(400);
    expect((await managerA.put("/storefront", body(0, { accentColor: "red" }))).status).toBe(400);
    const light = await managerA.put("/storefront", body(0, { accentColor: "#ffe066" }));
    expect(light.status).toBe(422);
    expect(light.body.error.code).toBe("accent_color_low_contrast");
    const foreign = await managerA.put(
      "/storefront",
      body(0, { featuredItemIds: [B.menu[0]!.id] }),
    );
    expect(foreign.status).toBe(422);
    expect(foreign.body.error.code).toBe("invalid_featured_item");
    const many = A.menu.slice(0, 9).map((m) => m.id);
    expect(many.length).toBe(9);
    expect((await managerA.put("/storefront", body(0, { featuredItemIds: many }))).status).toBe(
      400,
    );
    expect((await managerA.put("/storefront", body(0, { phone: "<script>" }))).status).toBe(400);
  });

  it("saves atomically with optimistic concurrency, and the public storefront shows it", async () => {
    const featured = [A.menu[2]!.id, A.menu[0]!.id];
    const saved = await managerA.put("/storefront", body(0, { featuredItemIds: featured }));
    expect(saved.status).toBe(200);
    expect(saved.body.version).toBe(1);
    expect(saved.body.featuredItemIds).toEqual(featured);
    // A second "first save" (stale version 0) is a conflict, not an overwrite.
    expect((await managerA.put("/storefront", body(0))).status).toBe(409);
    const stale = await managerA.put("/storefront", body(5));
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");

    const store = await storefront(h.app, A.storeToken!).store();
    expect(store.body.profile).toMatchObject({
      displayName: "Tokyo Sushi House",
      description: { ja: "旬のネタを握ります。", en: "Seasonal nigiri." },
      announcement: { ja: "年末年始は休業します。", en: null },
      phone: "03-1234-5678",
      accentColor: "#1d4ed8",
    });
    expect(store.body.featuredItemIds).toEqual(featured);

    // The table QR page gets the presentation fields only (no phone/address needed at the table).
    const table = await request(h.app).get(`/api/v1/public/tables/${A.tables[0]!.qrToken}`);
    expect(table.body.profile).toEqual({
      displayName: "Tokyo Sushi House",
      logo: null,
      accentColor: "#1d4ed8",
      announcement: { ja: "年末年始は休業します。", en: null },
    });
  });

  it("hides featured items that customers cannot see (inactive)", async () => {
    const id = A.menu[2]!.id;
    await h.asTenant(A.tenantId, (tx) =>
      tx.updateTable("menu_items").set({ is_active: false }).where("id", "=", id).execute(),
    );
    const store = await storefront(h.app, A.storeToken!).store();
    expect(store.body.featuredItemIds).toEqual([A.menu[0]!.id]);
    await h.asTenant(A.tenantId, (tx) =>
      tx.updateTable("menu_items").set({ is_active: true }).where("id", "=", id).execute(),
    );
  });

  it("is tenant-scoped: another restaurant neither sees nor changes it", async () => {
    const b = await managerB.get("/storefront");
    expect(b.body.version).toBe(0);
    expect(b.body.profile.displayName).toBeNull();
    const bStore = await storefront(h.app, B.storeToken!).store();
    expect(bStore.body.profile.displayName).toBeNull();
    expect((await managerB.put("/storefront", body(0, { displayName: "B" }))).status).toBe(200);
    expect((await managerA.get("/storefront")).body.profile.displayName).toBe("Tokyo Sushi House");
  });
});

describe("storefront images", () => {
  it("uploads, serves, replaces and removes a cover through the image pipeline", async () => {
    const first = await uploadImage(managerA, "cover", await jpeg());
    expect(first.status).toBe(201);
    const url = first.body.image.url as string;
    expect(url).toMatch(
      /^\/api\/v1\/public\/media\/storefront-images\/[0-9a-f-]{36}\/[A-Za-z0-9_-]{22}\/main\.webp$/,
    );
    expect(first.body.image.width).toBe(1200);
    const served = await request(h.app).get(first.body.image.thumbUrl as string);
    expect(served.status).toBe(200);
    expect(served.headers["content-type"]).toBe("image/webp");

    const store = await storefront(h.app, A.storeToken!).store();
    expect(store.body.profile.cover.url).toBe(url);

    const second = await uploadImage(managerA, "cover", await jpeg());
    expect(second.status).toBe(200);
    expect((await request(h.app).get(url)).status).toBe(404); // the replaced cover is no longer served

    const del = await request(h.app)
      .delete("/api/v1/storefront/images/cover")
      .set("Cookie", managerA.cookie)
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", managerA.csrf);
    expect(del.status).toBe(204);
    expect((await request(h.app).get(second.body.image.url as string)).status).toBe(404);
    expect((await storefront(h.app, A.storeToken!).store()).body.profile.cover).toBeNull();
  });

  it("rejects non-images and unknown kinds; forged keys are never served", async () => {
    const bad = await uploadImage(managerA, "logo", Buffer.from("<svg onload=alert(1)>"));
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.status).toBeLessThan(500);
    expect((await uploadImage(managerA, "banner", await jpeg())).status).toBe(400);
    const forged = `/api/v1/public/media/storefront-images/${A.tenantId}/${"a".repeat(22)}/main.webp`;
    expect((await request(h.app).get(forged)).status).toBe(404);
  });

  it("the logo appears on the QR page and on order tracking", async () => {
    const up = await uploadImage(managerA, "logo", await jpeg());
    expect(up.status).toBe(201);
    const table = await request(h.app).get(`/api/v1/public/tables/${A.tables[1]!.qrToken}`);
    expect(table.body.profile.logo.thumbUrl).toBe(up.body.image.thumbUrl);
    const shop = storefront(h.app, A.storeToken!);
    const placed = await shop.place("pickup", [{ menuItemId: A.menu[0]!.id, quantity: 3 }]);
    const tracked = await shop.track(placed.trackingToken);
    expect(tracked.status).toBe(200);
    expect(tracked.body.profile).toMatchObject({
      displayName: "Tokyo Sushi House",
      phone: "03-1234-5678",
    });
    expect(tracked.body.profile.logo.thumbUrl).toBe(up.body.image.thumbUrl);
    // Still no customer personal data on the tracking view.
    expect(JSON.stringify(tracked.body)).not.toMatch(/Taro Yamada/);
  });
});

describe("dine-in running bill", () => {
  it("shows the bill of the guest's own session only", async () => {
    const guest = await joinAsGuest(h.app, A.tables[2]!.qrToken);
    const before = await guest.session();
    expect(before.body.bill.totalYen).toBe(0);
    const item = A.menu[0]!;
    expect((await guest.order([{ menuItemId: item.id, quantity: 2 }])).status).toBe(201);
    const after = await guest.session();
    expect(after.body.bill.totalYen).toBe(item.priceYen * 2);
    expect(after.body.bill.pricesIncludeTax).toBe(true);

    // A guest at another table does not see this table's bill.
    const other = await joinAsGuest(h.app, A.tables[3]!.qrToken);
    expect((await other.session()).body.bill.totalYen).toBe(0);
  });
});
