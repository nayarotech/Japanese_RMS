/**
 * Online ordering (Standard package): entitlements, pickup and delivery submission, server-side pricing, delivery
 * area, minimums, hours/pause, idempotency, acceptance races, rejection, kitchen integration, fulfilment, payment
 * state, cancellation, isolation, privacy and transactional rollback. Real PostgreSQL (RLS) and Redis.
 */
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "../../src/infrastructure/database/db.js";
import type { TenantFixture } from "../../src/infrastructure/database/fixtures.js";
import {
  GeocodingUnavailableError,
  disabledGeocoder,
} from "../../src/modules/integrations/index.js";
import { type StaffClient, loginStaff } from "../helpers/clients.js";
import { type Harness, TEST_PASSWORD, createHarness } from "../helpers/harness.js";
import { randomPhone, storefront } from "../helpers/online.js";

let h: Harness;
let S: TenantFixture; // Standard plan, online ordering configured
let B: TenantFixture; // Basic plan (settings rows exist, but the plan does not include online ordering)
let X: TenantFixture; // another Standard tenant (isolation)
let cashier: StaffClient;
let manager: StaffClient;
let kitchen: StaffClient;
let waiter: StaffClient;
let shop: ReturnType<typeof storefront>;

const KARAAGE = () => S.menu[0]!; // ¥980, food: 8% takeout
const EDAMAME = () => S.menu[4]!; // ¥380, food: 8% takeout
const BEER = () => S.menu[6]!; // ¥550, alcohol: 10% takeout

beforeAll(async () => {
  h = await createHarness();
  [S, B, X] = await Promise.all([
    h.fixture({ planCode: "standard", online: true }),
    h.fixture({ planCode: "basic", online: true }),
    h.fixture({ planCode: "standard", online: true }),
  ]);
  [cashier, manager, kitchen, waiter] = await Promise.all([
    loginStaff(h.app, S.users.cashier.email, TEST_PASSWORD),
    loginStaff(h.app, S.users.manager.email, TEST_PASSWORD),
    loginStaff(h.app, S.users.kitchen.email, TEST_PASSWORD),
    loginStaff(h.app, S.users.waiter.email, TEST_PASSWORD),
  ]);
  shop = storefront(h.app, S.storeToken!);
});
afterAll(async () => h.close());

const asS = <T>(fn: (tx: Tx) => Promise<T>) => h.asTenant(S.tenantId, fn);

async function onlineRow(id: string) {
  return h.asTenant(S.tenantId, (tx) =>
    tx.selectFrom("online_orders").selectAll().where("id", "=", id).executeTakeFirstOrThrow(),
  );
}

/** Accept, then let the kitchen start and finish the whole ticket. */
async function acceptAndCook(id: string) {
  expect((await cashier.post(`/online-orders/${id}/accept`)).status).toBe(200);
  const detail = (await cashier.get(`/online-orders/${id}`)).body;
  const kt = (await kitchen.get("/kitchen/tickets")).body.tickets.find(
    (t: { orderId: string }) => t.orderId === detail.orderId,
  );
  expect((await kitchen.post(`/kitchen/tickets/${kt.id}/start`)).status).toBe(200);
  expect((await kitchen.post(`/kitchen/tickets/${kt.id}/ready`)).status).toBe(200);
  return kt.id as string;
}

// ---------------------------------------------------------------- 1, 2: entitlements

describe("subscription entitlements", () => {
  it("a Standard restaurant's storefront is open and takes orders", async () => {
    const store = await shop.store();
    expect(store.status).toBe(200);
    expect(store.body.state).toBe("open");
    expect(store.body.pickup.slots.length).toBeGreaterThan(0);
    expect(store.body.delivery).toMatchObject({ radiusM: 4000, distanceBasis: "straight_line" });
    const placed = await shop.place("pickup", [{ menuItemId: KARAAGE().id, quantity: 2 }]);
    expect(placed).toMatchObject({ status: "pending_acceptance", orderNo: expect.any(Number) });
    expect(placed.trackingToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("a Basic restaurant cannot use online ordering, on any surface (fail closed)", async () => {
    const basicShop = storefront(h.app, B.storeToken!);
    const store = await basicShop.store();
    expect(store.body).toMatchObject({
      state: "unavailable",
      menu: [],
      pickup: null,
      delivery: null,
    });
    const order = await basicShop.submit({
      fulfillmentType: "pickup",
      items: [{ menuItemId: B.menu[0]!.id, quantity: 1 }],
      pickupTime: new Date(Date.now() + 3_600_000).toISOString(),
      contact: { name: "A", phone: randomPhone() },
      paymentMethod: "pay_on_pickup",
      expectedTotalYen: 980,
    });
    expect(order.status).toBe(403);
    expect(order.body.error).toMatchObject({
      code: "feature_not_entitled",
      details: { feature: "online_ordering" },
    });
    const owner = await loginStaff(h.app, B.users.owner.email, TEST_PASSWORD);
    for (const res of [
      await owner.get("/online-orders"),
      await owner.get("/online/settings"),
      await owner.post("/online/pause"),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("feature_not_entitled");
    }
    // The UI is not the guard: the staff session simply does not list the feature either.
    expect((await owner.get("/auth/me")).body.features).not.toContain("online_ordering");
  });

  it("a platform-granted override enables a Basic location; expiry and revocation take it away", async () => {
    const grant = (feature: string, expiresAt: Date | null) =>
      h.migratorDb.transaction().execute(async (tx) => {
        await sql`SELECT set_config('app.tenant_id', ${B.tenantId}, true)`.execute(tx);
        return tx
          .insertInto("entitlement_overrides")
          .values({
            tenant_id: B.tenantId,
            location_id: B.locationId,
            feature_key: feature,
            effect: "grant",
            reason: "Pilot of online ordering (ticket OPS-1)",
            granted_by: "platform-operator@example.test",
            expires_at: expiresAt,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
      });
    const basicShop = storefront(h.app, B.storeToken!);
    const expired = await grant("online_ordering", new Date(Date.now() + 1000));
    await grant("pickup_ordering", null);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await basicShop.store()).body.state).toBe("unavailable"); // grant expired
    const active = await grant("online_ordering", new Date(Date.now() + 3_600_000));
    expect((await basicShop.store()).body.state).toBe("open");
    expect((await basicShop.store()).body.delivery).toBeNull(); // delivery_management not granted
    await basicShop.place("pickup", [{ menuItemId: B.menu[0]!.id, quantity: 2 }]);
    // The runtime role can neither create nor change overrides (only platform operators can).
    await expect(
      h.asTenant(B.tenantId, (tx) =>
        tx
          .updateTable("entitlement_overrides")
          .set({ revoked_at: new Date() })
          .where("id", "=", active.id)
          .execute(),
      ),
    ).rejects.toThrow(/permission denied/);
    await h.migratorDb.transaction().execute(async (tx) => {
      await sql`SELECT set_config('app.tenant_id', ${B.tenantId}, true)`.execute(tx);
      await tx
        .updateTable("entitlement_overrides")
        .set({ revoked_at: new Date() })
        .where("id", "in", [active.id, expired.id])
        .execute();
    });
    expect((await basicShop.store()).body.state).toBe("unavailable");
  });

  it("operational settings never grant features: a Basic owner cannot switch online ordering on", async () => {
    const owner = await loginStaff(h.app, B.users.owner.email, TEST_PASSWORD);
    const res = await owner.put("/online/settings", {
      version: 1,
      settings: {
        enabled: true,
        paused: false,
        pickupEnabled: true,
        deliveryEnabled: true,
        payAtHandoverEnabled: true,
        pickupPrepMinutes: 10,
        pickupSlotMinutes: 15,
        pickupDaysAhead: 0,
        deliveryPrepMinutes: 40,
        minOrderYen: 0,
        storeLocation: { latitude: 35.6595, longitude: 139.7004 },
        checkoutNote: { ja: null, en: null },
      },
      hours: [],
      tiers: [{ maxDistanceM: 2000, feeYen: 0, minOrderYen: 0 }],
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("feature_not_entitled");
    expect((await owner.get("/auth/me")).body.features).not.toContain("delivery_management");
  });
});

// ---------------------------------------------------------------- 3, 4, 5: creation

describe("order creation", () => {
  it("creates a pickup order on the SHARED order model with takeout tax and no table", async () => {
    const placed = await shop.place("pickup", [
      { menuItemId: KARAAGE().id, quantity: 2, note: "No mayonnaise" },
      { menuItemId: BEER().id, quantity: 1 },
    ]);
    const row = await onlineRow(placed.onlineOrderId);
    expect(row).toMatchObject({
      fulfillment_type: "pickup",
      status: "pending_acceptance",
      payment_method: "pay_on_pickup",
      payment_status: "unpaid",
      items_subtotal_yen: 2510,
      delivery_fee_yen: 0,
      total_yen: 2510,
      tax_total_yen: 195,
      delivery_distance_m: null,
    });
    // Reduced 8% for food, standard 10% for alcohol (takeout), tax per rate per order.
    expect(row.tax_breakdown).toEqual([
      { rateBp: 1000, baseYen: 550, taxYen: 50 },
      { rateBp: 800, baseYen: 1960, taxYen: 145 },
    ]);
    const order = await asS((tx) =>
      tx.selectFrom("orders").selectAll().where("id", "=", row.order_id).executeTakeFirstOrThrow(),
    );
    expect(order).toMatchObject({
      source: "ONLINE_PICKUP",
      table_session_id: null,
      order_no: placed.orderNo,
    });
    const tickets = await asS((tx) =>
      tx.selectFrom("kitchen_tickets").select("id").where("order_id", "=", row.order_id).execute(),
    );
    expect(tickets).toHaveLength(0); // not in the kitchen until the restaurant accepts it
    const scheduled = new Date(placed.scheduledFor).getTime();
    expect(scheduled).toBeGreaterThanOrEqual(Date.now() + 9 * 60_000); // >= now + prep (10 min)
  });

  it("creates a delivery order with a server-calculated, stored fee snapshot", async () => {
    const placed = await shop.place(
      "delivery",
      [
        { menuItemId: KARAAGE().id, quantity: 2 },
        { menuItemId: EDAMAME().id, quantity: 1 },
      ],
      { postalCode: "151-0053" }, // ~2.6 km: ¥300 tier, ¥2,000 minimum
    );
    const row = await onlineRow(placed.onlineOrderId);
    expect(row).toMatchObject({
      fulfillment_type: "delivery",
      payment_method: "cash_on_delivery",
      items_subtotal_yen: 2340,
      delivery_fee_yen: 300,
      total_yen: 2640,
      tax_total_yen: 200,
    });
    expect(row.delivery_distance_m).toBeGreaterThan(2000);
    expect(row.delivery_distance_m).toBeLessThan(4000);
    const contact = await asS((tx) =>
      tx
        .selectFrom("online_order_contacts")
        .selectAll()
        .where("online_order_id", "=", row.id)
        .executeTakeFirstOrThrow(),
    );
    expect(contact).toMatchObject({
      postal_code: "1510053",
      geocode_precision: "postal_code",
      city: "渋谷区",
    });
  });

  it("keeps item-specific notes as separate, normalized lines all the way to the kitchen", async () => {
    const placed = await shop.place("pickup", [
      { menuItemId: S.menu[1]!.id, quantity: 1, note: "Less spicy" },
      { menuItemId: S.menu[1]!.id, quantity: 1, note: "  Extra\nnoodles‮ " },
    ]);
    await cashier.post(`/online-orders/${placed.onlineOrderId}/accept`);
    const detail = (await cashier.get(`/online-orders/${placed.onlineOrderId}`)).body;
    expect(detail.items.map((i: { note: string }) => i.note)).toEqual([
      "Less spicy",
      "Extra noodles",
    ]);
    const ticket = (await kitchen.get("/kitchen/tickets")).body.tickets.find(
      (t: { orderId: string }) => t.orderId === detail.orderId,
    );
    expect(ticket.items.map((i: { note: string }) => i.note)).toEqual([
      "Less spicy",
      "Extra noodles",
    ]);
  });
});

// ---------------------------------------------------------------- 6, 7, 8: delivery area, fees, minimums

describe("delivery eligibility, fees and minimums are decided by the server", () => {
  const body = (postalCode: string, extra: object = {}) => ({
    fulfillmentType: "delivery",
    items: [{ menuItemId: KARAAGE().id, quantity: 3 }],
    address: {
      postalCode,
      prefecture: "東京都",
      city: "千代田区",
      line1: "1-1",
      ...extra,
    },
    contact: { name: "Hanako", phone: randomPhone() },
    paymentMethod: "cash_on_delivery",
    expectedTotalYen: 2940,
  });

  it("refuses unknown addresses and addresses outside the delivery area", async () => {
    const unknown = await shop.submit(body("999-9999"));
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe("address_not_found");
    const far = await shop.submit(body("100-0005")); // ~6.5 km
    expect(far.status).toBe(422);
    expect(far.body.error).toMatchObject({
      code: "outside_delivery_area",
      details: { radiusM: 4000 },
    });
    const badPostal = await shop.submit(body("12-34"));
    expect(badPostal.status).toBe(400);
  });

  it("never accepts client-supplied fees, totals or coordinates", async () => {
    const fee = await shop.submit({ ...body("150-0002"), deliveryFeeYen: 0 });
    expect(fee.status).toBe(400);
    const coords = await shop.submit(body("150-0002", { latitude: 35.6595, longitude: 139.7004 }));
    expect(coords.status).toBe(400);
    const price = await shop.submit({
      ...body("150-0002"),
      items: [{ menuItemId: KARAAGE().id, quantity: 3, unitPriceYen: 1 }],
    });
    expect(price.status).toBe(400);
    // A lower "reviewed" total (e.g. pretending the 2-4 km zone is free) is refused, nothing is created.
    const before = await countOnline();
    const wrong = await shop.submit({ ...body("151-0053"), expectedTotalYen: 2940 }); // actual 2940 + 300
    expect(wrong.status).toBe(409);
    expect(wrong.body.error).toMatchObject({ code: "total_changed", details: { totalYen: 3240 } });
    expect(await countOnline()).toBe(before);
  });

  it("enforces the store minimum and the delivery-zone minimum on the item subtotal", async () => {
    const tooSmall = await shop.submit({
      fulfillmentType: "pickup",
      items: [{ menuItemId: EDAMAME().id, quantity: 1 }],
      pickupTime: (await shop.store()).body.pickup.slots[0],
      contact: { name: "A", phone: randomPhone() },
      paymentMethod: "pay_on_pickup",
      expectedTotalYen: 380,
    });
    expect(tooSmall.status).toBe(422);
    expect(tooSmall.body.error).toMatchObject({
      code: "below_minimum_order",
      details: { minimumYen: 1000 },
    });
    // 0-2 km zone needs ¥1,500 of food: ¥980 is enough for pickup but not for delivery.
    const zone = await shop.submit({
      ...body("150-0002"),
      items: [{ menuItemId: KARAAGE().id, quantity: 1 }],
      expectedTotalYen: 980,
    });
    expect(zone.status).toBe(422);
    expect(zone.body.error.details.minimumYen).toBe(1500);
    const quote = await shop.quote({
      fulfillmentType: "delivery",
      items: [{ menuItemId: KARAAGE().id, quantity: 1 }],
      address: body("150-0002").address,
    });
    expect(quote.body).toMatchObject({ meetsMinimum: false, minimumYen: 1500, deliveryFeeYen: 0 });
  });

  it("fails closed when the geocoding provider is down or not configured", async () => {
    const down = await createHarness({
      geocoder: {
        name: "down",
        enabled: true,
        geocode: () => Promise.reject(new GeocodingUnavailableError("timeout")),
      },
    });
    const none = await createHarness({ geocoder: disabledGeocoder });
    try {
      const res = await storefront(down.app, S.storeToken!).submit(body("150-0002"));
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("geocoding_unavailable");
      const noProvider = storefront(none.app, S.storeToken!);
      expect((await noProvider.store()).body.delivery).toBeNull();
      expect((await noProvider.submit(body("150-0002"))).body.error.code).toBe(
        "delivery_unavailable",
      );
      // Pickup keeps working without a geocoder.
      expect((await noProvider.store()).body.pickup).not.toBeNull();
    } finally {
      await Promise.all([down.close(), none.close()]);
    }
  });
});

async function countOnline() {
  const r = await asS((tx) =>
    tx
      .selectFrom("online_orders")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .executeTakeFirstOrThrow(),
  );
  return Number(r.n);
}

// ---------------------------------------------------------------- 9, 10: hours and pause

describe("ordering hours and pause", () => {
  let C: TenantFixture;
  let cManager: StaffClient;
  let cShop: ReturnType<typeof storefront>;
  beforeAll(async () => {
    C = await h.fixture({ planCode: "standard", online: true });
    cManager = await loginStaff(h.app, C.users.manager.email, TEST_PASSWORD);
    cShop = storefront(h.app, C.storeToken!);
  });
  const order = (slot: string | null) => ({
    fulfillmentType: "pickup",
    items: [{ menuItemId: C.menu[0]!.id, quantity: 2 }],
    pickupTime: slot ?? new Date(Date.now() + 3_600_000).toISOString(),
    contact: { name: "A", phone: randomPhone() },
    paymentMethod: "pay_on_pickup",
    expectedTotalYen: 1960,
  });

  it("refuses orders while closed and only accepts the server's own pickup slots", async () => {
    const view = (await cManager.get("/online/settings")).body;
    const today = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      timeZone: "Asia/Tokyo",
    }).format(new Date());
    const todayIdx = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(today);
    const other = (todayIdx + 3) % 7;
    const closed = await cManager.put("/online/settings", {
      version: view.version,
      settings: view.settings,
      hours: [{ weekday: other, opensAt: "11:00", closesAt: "14:00" }],
      tiers: view.tiers,
    });
    expect(closed.status).toBe(200);
    const store = (await cShop.store()).body;
    expect(store.state).toBe("closed");
    expect(store.pickup.slots).toEqual([]);
    const res = await cShop.submit(order(null));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("store_closed");

    // Re-open (always open) and try a time that is not one of the offered slots.
    const reopened = await cManager.put("/online/settings", {
      version: closed.body.version,
      settings: closed.body.settings,
      hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        opensAt: "00:00",
        closesAt: "24:00",
      })),
      tiers: view.tiers,
    });
    expect(reopened.status).toBe(200);
    const offslot = await cShop.submit(order(new Date(Date.now() + 61_000).toISOString()));
    expect(offslot.body.error.code).toBe("invalid_pickup_time");
    const good = await cShop.submit(order((await cShop.store()).body.pickup.slots[1]));
    expect(good.status).toBe(201);
  });

  it("pausing stops new orders immediately and resuming restores them", async () => {
    const cashierC = await loginStaff(h.app, C.users.cashier.email, TEST_PASSWORD);
    expect((await cashierC.post("/online/pause")).status).toBe(204);
    expect((await cShop.store()).body.state).toBe("paused");
    const slot = (await cShop.store()).body.pickup.slots[0];
    const res = await cShop.submit(order(slot));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ordering_paused");
    expect((await cashierC.post("/online/resume")).status).toBe(204);
    expect((await cShop.submit(order((await cShop.store()).body.pickup.slots[0]))).status).toBe(
      201,
    );
  });

  it("a paused store never spends a geocoding call on a delivery address", async () => {
    let calls = 0;
    const counting = await createHarness({
      geocoder: {
        name: "counting",
        enabled: true,
        geocode: () => {
          calls += 1;
          return Promise.resolve({
            latitude: 35.659,
            longitude: 139.706,
            precision: "postal_code",
          });
        },
      },
    });
    const cashierC = await loginStaff(h.app, C.users.cashier.email, TEST_PASSWORD);
    try {
      await cashierC.post("/online/pause");
      const res = await storefront(counting.app, C.storeToken!).submit({
        fulfillmentType: "delivery",
        items: [{ menuItemId: C.menu[0]!.id, quantity: 3 }],
        address: { postalCode: "1500002", prefecture: "東京都", city: "渋谷区", line1: "1-1" },
        contact: { name: "A", phone: randomPhone() },
        paymentMethod: "cash_on_delivery",
        expectedTotalYen: 2940,
      });
      expect(res.body.error.code).toBe("ordering_paused");
      expect(calls).toBe(0);
    } finally {
      await cashierC.post("/online/resume");
      await counting.close();
    }
  });

  it("settings are validated, versioned and restricted to managers", async () => {
    const cashierC = await loginStaff(h.app, C.users.cashier.email, TEST_PASSWORD);
    expect((await cashierC.get("/online/settings")).status).toBe(403);
    const view = (await cManager.get("/online/settings")).body;
    const noStore = await cManager.put("/online/settings", {
      version: view.version,
      settings: { ...view.settings, storeLocation: null },
      hours: view.hours,
      tiers: view.tiers,
    });
    expect(noStore.body.error.code).toBe("delivery_not_configured");
    const overlapping = await cManager.put("/online/settings", {
      version: view.version,
      settings: view.settings,
      hours: [
        { weekday: 1, opensAt: "11:00", closesAt: "14:00" },
        { weekday: 1, opensAt: "13:00", closesAt: "15:00" },
      ],
      tiers: view.tiers,
    });
    expect(overlapping.body.error.code).toBe("invalid_hours");
    const stale = await cManager.put("/online/settings", {
      version: view.version - 1,
      settings: view.settings,
      hours: view.hours,
      tiers: view.tiers,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
  });
});

// ---------------------------------------------------------------- 11, 12: duplicates and races

describe("duplicate submissions and simultaneous staff actions", () => {
  it("a double-submitted order (same Idempotency-Key) creates exactly one order", async () => {
    const body = await shop.body("pickup", [{ menuItemId: KARAAGE().id, quantity: 2 }]);
    const key = randomUUID();
    const before = await countOnline();
    const [a, b] = await Promise.all([shop.submit(body, key), shop.submit(body, key)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.onlineOrderId).toBe(b.body.onlineOrderId);
    expect(await countOnline()).toBe(before + 1);
    // Each response carries its own working tracking token (raw tokens are never stored for replay).
    expect(a.body.trackingToken).not.toBe(b.body.trackingToken);
    expect((await shop.track(a.body.trackingToken)).status).toBe(200);
    expect((await shop.track(b.body.trackingToken)).status).toBe(200);
    const reused = await shop.submit(
      { ...body, items: [{ menuItemId: BEER().id, quantity: 2 }] },
      key,
    );
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("idempotency_key_reused");
  });

  it("two staff accepting at the same moment: exactly one acceptance and one kitchen ticket", async () => {
    const placed = await shop.place("pickup", [{ menuItemId: KARAAGE().id, quantity: 2 }]);
    const [x, y] = await Promise.all([
      cashier.post(`/online-orders/${placed.onlineOrderId}/accept`),
      manager.post(`/online-orders/${placed.onlineOrderId}/accept`),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const loser = x.status === 409 ? x : y;
    expect(["invalid_online_order_transition", "concurrent_update"]).toContain(
      loser.body.error.code,
    );
    const row = await onlineRow(placed.onlineOrderId);
    const tickets = await asS((tx) =>
      tx.selectFrom("kitchen_tickets").select("id").where("order_id", "=", row.order_id).execute(),
    );
    expect(tickets).toHaveLength(1);
    const history = await asS((tx) =>
      tx
        .selectFrom("online_order_status_history")
        .select("to_status")
        .where("online_order_id", "=", row.id)
        .execute(),
    );
    expect(history.filter((x) => x.to_status === "accepted")).toHaveLength(1);
  });

  it("anti-spam: per-IP rate limit and a cap on pending orders per phone number", async () => {
    const strict = await createHarness({
      limits: { onlineOrderPerIp: { points: 2, durationSeconds: 600 } },
    });
    try {
      const s2 = storefront(strict.app, S.storeToken!);
      const make = async () =>
        s2.submit(await s2.body("pickup", [{ menuItemId: KARAAGE().id, quantity: 2 }]));
      expect((await make()).status).toBe(201);
      expect((await make()).status).toBe(201);
      const limited = await make();
      expect(limited.status).toBe(429);
      expect(limited.headers["retry-after"]).toBeDefined();
    } finally {
      await strict.close();
    }
    const phone = randomPhone();
    for (let i = 0; i < 3; i++) {
      expect(
        (
          await shop.submit(
            await shop.body("pickup", [{ menuItemId: KARAAGE().id, quantity: 2 }], { phone }),
          )
        ).status,
      ).toBe(201);
    }
    const fourth = await shop.submit(
      await shop.body("pickup", [{ menuItemId: KARAAGE().id, quantity: 2 }], {
        phone: phone.replace(/^090/, "+8190"),
      }),
    );
    expect(fourth.status).toBe(429);
    expect(fourth.body.error.code).toBe("too_many_pending_orders");
  });
});

// ---------------------------------------------------------------- 13: rejection

describe("rejection", () => {
  it("requires a valid reason, voids the order and is visible to the customer and the audit trail", async () => {
    const placed = await shop.place("pickup", [{ menuItemId: KARAAGE().id, quantity: 2 }]);
    const id = placed.onlineOrderId;
    expect((await cashier.post(`/online-orders/${id}/reject`, {})).status).toBe(400);
    expect((await cashier.post(`/online-orders/${id}/reject`, { reason: "because" })).status).toBe(
      400,
    );
    const other = await cashier.post(`/online-orders/${id}/reject`, { reason: "other" });
    expect(other.status).toBe(400);
    const ok = await cashier.post(`/online-orders/${id}/reject`, {
      reason: "item_unavailable",
      note: "Out of chicken",
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      status: "rejected",
      paymentStatus: "voided",
      rejectionReason: "item_unavailable",
    });
    expect((await cashier.post(`/online-orders/${id}/accept`)).status).toBe(409);
    const items = await asS((tx) =>
      tx
        .selectFrom("order_items")
        .select("status")
        .where("order_id", "=", ok.body.orderId)
        .execute(),
    );
    expect(items.every((i) => i.status === "voided")).toBe(true);
    const audit = await asS((tx) =>
      tx
        .selectFrom("audit_events")
        .select(["action", "metadata"])
        .where("target_id", "=", id)
        .execute(),
    );
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["online_order.submitted", "online_order.rejected"]),
    );
    const track = (await shop.track(placed.trackingToken)).body;
    expect(track).toMatchObject({
      status: "rejected",
      rejectionReason: "item_unavailable",
      canCancel: false,
    });
    expect(JSON.stringify(track)).not.toContain("Out of chicken"); // internal note stays internal
  });
});

// ---------------------------------------------------------------- 14, 17: kitchen + pickup completion

describe("kitchen integration and pickup completion", () => {
  it("an accepted order flows through the EXISTING kitchen workflow and drives the online status", async () => {
    const placed = await shop.place("pickup", [
      { menuItemId: KARAAGE().id, quantity: 1 },
      { menuItemId: BEER().id, quantity: 1 },
    ]);
    const id = placed.onlineOrderId;
    expect((await cashier.post(`/online-orders/${id}/accept`)).body.status).toBe("accepted");
    const detail = (await cashier.get(`/online-orders/${id}`)).body;
    const ticket = (await kitchen.get("/kitchen/tickets")).body.tickets.find(
      (t: { orderId: string }) => t.orderId === detail.orderId,
    );
    expect(ticket).toMatchObject({
      source: "ONLINE_PICKUP",
      orderNo: placed.orderNo,
      tableName: null,
      tableSessionId: null,
      status: "new",
      dueAt: placed.scheduledFor,
    });
    await kitchen.post(`/kitchen/items/${ticket.items[0].id}/start`);
    expect((await onlineRow(id)).status).toBe("preparing");
    await kitchen.post(`/kitchen/items/${ticket.items[0].id}/ready`);
    expect((await onlineRow(id)).status).toBe("preparing"); // partial readiness never marks the order ready
    await kitchen.post(`/kitchen/tickets/${ticket.id}/start`);
    await kitchen.post(`/kitchen/tickets/${ticket.id}/ready`);
    expect((await onlineRow(id)).status).toBe("ready");
    // Online food is handed over by the online workflow, not "served" at a table.
    const serve = await waiter.post(`/floor/tickets/${ticket.id}/serve`);
    expect(serve.status).toBe(409);
    expect(serve.body.error.code).toBe("online_handover_required");
    const floor = (await waiter.get("/floor/ready-items")).body.items as { ticketId: string }[];
    expect(floor.some((i) => i.ticketId === ticket.id)).toBe(false);
  });

  it("pickup is completed only with payment; payment and hand-over are recorded accurately", async () => {
    const placed = await shop.place("pickup", [{ menuItemId: KARAAGE().id, quantity: 2 }]);
    const id = placed.onlineOrderId;
    const early = await cashier.post(
      `/online-orders/${id}/complete`,
      {},
      { "Idempotency-Key": randomUUID() },
    );
    expect(early.status).toBe(409); // not accepted/ready yet
    const ticketId = await acceptAndCook(id);
    const unpaid = await cashier.post(
      `/online-orders/${id}/complete`,
      {},
      { "Idempotency-Key": randomUUID() },
    );
    expect(unpaid.status).toBe(422);
    expect(unpaid.body.error).toMatchObject({
      code: "payment_required",
      details: { totalYen: 1960 },
    });
    // A waiter may hand over, but cannot take money.
    const waiterCash = await waiter.post(
      `/online-orders/${id}/complete`,
      { amountReceivedYen: 2000, expectedTotalYen: 1960 },
      { "Idempotency-Key": randomUUID() },
    );
    expect(waiterCash.status).toBe(403);
    const short = await cashier.post(
      `/online-orders/${id}/complete`,
      { amountReceivedYen: 1000, expectedTotalYen: 1960 },
      { "Idempotency-Key": randomUUID() },
    );
    expect(short.body.error.code).toBe("insufficient_cash");
    const key = randomUUID();
    const done = await cashier.post(
      `/online-orders/${id}/complete`,
      { amountReceivedYen: 5000, expectedTotalYen: 1960 },
      { "Idempotency-Key": key },
    );
    expect(done.status).toBe(200);
    expect(done.body.order).toMatchObject({ status: "completed", paymentStatus: "paid" });
    expect(done.body.payment).toMatchObject({
      amountDueYen: 1960,
      amountReceivedYen: 5000,
      changeYen: 3040,
    });
    const replay = await cashier.post(
      `/online-orders/${id}/complete`,
      { amountReceivedYen: 5000, expectedTotalYen: 1960 },
      { "Idempotency-Key": key },
    );
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    const payments = await asS((tx) =>
      tx
        .selectFrom("payments")
        .selectAll()
        .where("order_id", "=", done.body.order.orderId)
        .execute(),
    );
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      table_session_id: null,
      method: "cash",
      amount_due_yen: 1960,
    });
    const open = (await kitchen.get("/kitchen/tickets")).body.tickets as { id: string }[];
    expect(open.some((t) => t.id === ticketId)).toBe(false); // handed over -> off the kitchen display
    expect((await shop.track(placed.trackingToken)).body).toMatchObject({
      status: "completed",
      paymentStatus: "paid",
    });
  });
});

// ---------------------------------------------------------------- 18, 19: delivery completion and payment state

describe("delivery completion and payment state", () => {
  it("delivered is NOT paid: cash on delivery is recorded separately, exactly once", async () => {
    const placed = await shop.place(
      "delivery",
      [
        { menuItemId: KARAAGE().id, quantity: 1 },
        { menuItemId: S.menu[2]!.id, quantity: 1 },
      ],
      { postalCode: "150-0001" },
    );
    const id = placed.onlineOrderId;
    await acceptAndCook(id);
    expect(
      (await cashier.post(`/online-orders/${id}/complete`, {}, { "Idempotency-Key": randomUUID() }))
        .status,
    ).toBe(409);
    expect((await waiter.post(`/online-orders/${id}/deliver`)).status).toBe(409); // must be dispatched first
    expect((await waiter.post(`/online-orders/${id}/dispatch`)).body.status).toBe(
      "out_for_delivery",
    );
    const delivered = await waiter.post(`/online-orders/${id}/deliver`);
    expect(delivered.body).toMatchObject({ status: "delivered", paymentStatus: "unpaid" });
    // Still on the active list until the cash is reconciled.
    const active = (await cashier.get("/online-orders?scope=active")).body.orders as {
      id: string;
    }[];
    expect(active.some((o) => o.id === id)).toBe(true);

    expect(
      (
        await waiter.post(
          `/online-orders/${id}/payments/cash`,
          { amountReceivedYen: 3000, expectedTotalYen: placed.totalYen },
          { "Idempotency-Key": randomUUID() },
        )
      ).status,
    ).toBe(403);
    const stale = await cashier.post(
      `/online-orders/${id}/payments/cash`,
      { amountReceivedYen: 3000, expectedTotalYen: placed.totalYen - 1 },
      { "Idempotency-Key": randomUUID() },
    );
    expect(stale.body.error.code).toBe("bill_changed");
    const [p1, p2] = await Promise.all([
      cashier.post(
        `/online-orders/${id}/payments/cash`,
        { amountReceivedYen: 3000, expectedTotalYen: placed.totalYen },
        { "Idempotency-Key": randomUUID() },
      ),
      manager.post(
        `/online-orders/${id}/payments/cash`,
        { amountReceivedYen: 3000, expectedTotalYen: placed.totalYen },
        { "Idempotency-Key": randomUUID() },
      ),
    ]);
    expect([p1.status, p2.status].sort()).toEqual([201, 409]);
    expect((p1.status === 409 ? p1 : p2).body.error.code).toBe("already_paid");
    expect((await onlineRow(id)).payment_status).toBe("paid");
    const payments = await asS((tx) =>
      tx
        .selectFrom("payments")
        .select("id")
        .where("order_id", "=", (p1.status === 201 ? p1 : p2).body.order.orderId)
        .execute(),
    );
    expect(payments).toHaveLength(1);
    const after = (await cashier.get("/online-orders?scope=active")).body.orders as {
      id: string;
    }[];
    expect(after.some((o) => o.id === id)).toBe(false);
  });

  it("a paid order that is cancelled is flagged for refund, never silently dropped", async () => {
    const placed = await shop.place("delivery", [{ menuItemId: KARAAGE().id, quantity: 2 }], {
      postalCode: "150-0002",
    });
    const id = placed.onlineOrderId;
    await acceptAndCook(id);
    await waiter.post(`/online-orders/${id}/dispatch`);
    await cashier.post(
      `/online-orders/${id}/payments/cash`,
      { amountReceivedYen: 2000, expectedTotalYen: placed.totalYen },
      { "Idempotency-Key": randomUUID() },
    );
    const cancelled = await manager.post(`/online-orders/${id}/cancel`, {
      reason: "delivery_failed",
      note: "Customer unreachable",
    });
    expect(cancelled.body).toMatchObject({
      status: "cancelled",
      paymentStatus: "refund_required",
      cancelledBy: "staff",
    });
    const active = (await cashier.get("/online-orders?scope=active")).body.orders as {
      id: string;
    }[];
    expect(active.some((o) => o.id === id)).toBe(true); // stays visible until the refund is handled
  });
});

// ---------------------------------------------------------------- 22: cancellation

describe("cancellation rules", () => {
  it("customers may cancel only before acceptance; staff cancellation after cooking needs a manager", async () => {
    const a = await shop.place("pickup", [{ menuItemId: KARAAGE().id, quantity: 2 }]);
    expect((await shop.cancel(a.trackingToken)).status).toBe(204);
    expect((await shop.track(a.trackingToken)).body).toMatchObject({
      status: "cancelled",
      cancelledBy: "customer",
      paymentStatus: "voided",
    });
    expect((await cashier.post(`/online-orders/${a.onlineOrderId}/accept`)).status).toBe(409);

    const b = await shop.place("pickup", [{ menuItemId: KARAAGE().id, quantity: 2 }]);
    expect(
      (
        await cashier.post(`/online-orders/${b.onlineOrderId}/cancel`, {
          reason: "customer_request",
        })
      ).body.error.code,
    ).toBe("use_reject");
    await cashier.post(`/online-orders/${b.onlineOrderId}/accept`);
    const late = await shop.cancel(b.trackingToken);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("invalid_online_order_transition");
    // Accepted but not started: the cashier may cancel; the kitchen ticket is voided.
    const ok = await cashier.post(`/online-orders/${b.onlineOrderId}/cancel`, {
      reason: "customer_request",
    });
    expect(ok.body.status).toBe("cancelled");
    const ticket = await asS((tx) =>
      tx
        .selectFrom("kitchen_tickets")
        .select("status")
        .where("order_id", "=", ok.body.orderId)
        .executeTakeFirstOrThrow(),
    );
    expect(ticket.status).toBe("voided");

    const c = await shop.place("pickup", [{ menuItemId: KARAAGE().id, quantity: 2 }]);
    await acceptAndCook(c.onlineOrderId);
    const byCashier = await cashier.post(`/online-orders/${c.onlineOrderId}/cancel`, {
      reason: "no_show",
    });
    expect(byCashier.status).toBe(403);
    const byManager = await manager.post(`/online-orders/${c.onlineOrderId}/cancel`, {
      reason: "no_show",
    });
    expect(byManager.body).toMatchObject({ status: "cancelled", cancellationReason: "no_show" });
  });
});

// ---------------------------------------------------------------- 20, 21: isolation and privacy

describe("tenant isolation and customer privacy", () => {
  it("another tenant cannot see or act on this tenant's online orders (HTTP and RLS)", async () => {
    const placed = await shop.place("delivery", [{ menuItemId: KARAAGE().id, quantity: 2 }]);
    const xOwner = await loginStaff(h.app, X.users.owner.email, TEST_PASSWORD);
    for (const res of [
      await xOwner.get(`/online-orders/${placed.onlineOrderId}`),
      await xOwner.get(`/online-orders/${placed.onlineOrderId}/contact`),
      await xOwner.post(`/online-orders/${placed.onlineOrderId}/accept`),
      await xOwner.post(`/online-orders/${placed.onlineOrderId}/reject`, { reason: "store_busy" }),
      await xOwner.post(
        `/online-orders/${placed.onlineOrderId}/payments/cash`,
        { amountReceivedYen: 9999, expectedTotalYen: 1 },
        { "Idempotency-Key": randomUUID() },
      ),
    ]) {
      expect(res.status).toBe(404);
    }
    const list = (await xOwner.get("/online-orders")).body.orders as { id: string }[];
    expect(list.some((o) => o.id === placed.onlineOrderId)).toBe(false);
    const viaRls = await h.asTenant(X.tenantId, (tx) =>
      tx
        .selectFrom("online_order_contacts")
        .select("name")
        .where("online_order_id", "=", placed.onlineOrderId)
        .execute(),
    );
    expect(viaRls).toHaveLength(0);
    // X's storefront cannot order S's menu items.
    const xShop = storefront(h.app, X.storeToken!);
    const cross = await xShop.quote({
      fulfillmentType: "pickup",
      items: [{ menuItemId: KARAAGE().id, quantity: 1 }],
    });
    expect(cross.status).toBe(422);
    expect((await onlineRow(placed.onlineOrderId)).status).toBe("pending_acceptance");
  });

  it("tracking needs a valid, unexpired, order-scoped token and reveals no personal data", async () => {
    const placed = await shop.place("delivery", [{ menuItemId: KARAAGE().id, quantity: 2 }]);
    expect((await shop.track(null)).status).toBe(401);
    expect((await shop.track("x".repeat(43))).status).toBe(401);
    const view = await shop.track(placed.trackingToken);
    expect(view.status).toBe(200);
    expect(view.body.onlineOrderId).toBe(placed.onlineOrderId);
    const json = JSON.stringify(view.body);
    for (const secret of ["Taro", "090", "1500002", "渋谷区", "Ring the bell", "latitude"]) {
      expect(json).not.toContain(secret);
    }
    // The order id alone is not a credential.
    const byId = await shop.track(placed.onlineOrderId);
    expect(byId.status).toBe(401);
    // Expiry and revocation end access.
    await h.migratorDb
      .updateTable("online_order_tracking_tokens")
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where("online_order_id", "=", placed.onlineOrderId)
      .execute();
    expect((await shop.track(placed.trackingToken)).status).toBe(401);
  });

  it("customer contact data needs its own permission, and every access is audited", async () => {
    const placed = await shop.place("delivery", [{ menuItemId: KARAAGE().id, quantity: 2 }]);
    expect((await kitchen.get(`/online-orders/${placed.onlineOrderId}`)).status).toBe(403);
    expect((await kitchen.get(`/online-orders/${placed.onlineOrderId}/contact`)).status).toBe(403);
    const list = (await cashier.get("/online-orders")).body;
    expect(JSON.stringify(list)).not.toContain("Taro"); // lists never include contact data
    const contact = await waiter.get(`/online-orders/${placed.onlineOrderId}/contact`);
    expect(contact.body).toMatchObject({ name: "Taro Yamada", address: { postalCode: "1500002" } });
    const audit = await asS((tx) =>
      tx
        .selectFrom("audit_events")
        .select("actor_id")
        .where("action", "=", "online_order.contact_viewed")
        .where("target_id", "=", placed.onlineOrderId)
        .execute(),
    );
    expect(audit).toEqual([{ actor_id: S.users.waiter.id }]);
    const events = await h.relayDb
      .selectFrom("outbox_events")
      .select("payload")
      .where("event_type", "like", "online.order.%")
      .execute();
    expect(JSON.stringify(events)).not.toMatch(/Taro|Ring the bell|渋谷区/);
  });
});

// ---------------------------------------------------------------- 23: rollback

describe("transactional rollback", () => {
  it("a failure while saving the order leaves nothing behind (order, lines, events, idempotency)", async () => {
    const body = await shop.body("pickup", [{ menuItemId: KARAAGE().id, quantity: 2 }], {
      name: "Fail Me",
    });
    const key = randomUUID();
    await sql
      .raw(
        `CREATE OR REPLACE FUNCTION app.test_fail_contact() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN IF NEW.name = 'Fail Me' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$;
         CREATE TRIGGER test_fail_contact BEFORE INSERT ON app.online_order_contacts FOR EACH ROW EXECUTE FUNCTION app.test_fail_contact();`,
      )
      .execute(h.migratorDb);
    const before = {
      online: await countOnline(),
      orders: await countOrders(),
      events: await countCreatedEvents(),
    };
    try {
      const res = await shop.submit(body, key);
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain("injected");
    } finally {
      await sql
        .raw(
          "DROP TRIGGER test_fail_contact ON app.online_order_contacts; DROP FUNCTION app.test_fail_contact();",
        )
        .execute(h.migratorDb);
    }
    expect({
      online: await countOnline(),
      orders: await countOrders(),
      events: await countCreatedEvents(),
    }).toEqual(before);
    const retry = await shop.submit(body, key); // the idempotency record was rolled back too
    expect(retry.status).toBe(201);
    expect(retry.headers["idempotent-replayed"]).toBeUndefined();
  });
});

async function countOrders() {
  const r = await asS((tx) =>
    tx
      .selectFrom("orders")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .executeTakeFirstOrThrow(),
  );
  return Number(r.n);
}
async function countCreatedEvents() {
  const r = await h.relayDb
    .selectFrom("outbox_events")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("event_type", "=", "online.order.created")
    .where("tenant_id", "=", S.tenantId)
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

// ---------------------------------------------------------------- 24: dine-in alongside online

describe("dine-in on a Standard plan is unchanged", () => {
  it("table orders and online orders share the kitchen display without interfering", async () => {
    const session = (await cashier.post(`/tables/${S.tables[0]!.id}/sessions`, { guestCount: 2 }))
      .body.session;
    const dineIn = await cashier.post(
      `/sessions/${session.id}/orders`,
      { items: [{ menuItemId: KARAAGE().id, quantity: 1, note: "Less salt" }] },
      { "Idempotency-Key": randomUUID() },
    );
    expect(dineIn.status).toBe(201);
    const placed = await shop.place("pickup", [{ menuItemId: KARAAGE().id, quantity: 2 }]);
    await cashier.post(`/online-orders/${placed.onlineOrderId}/accept`);
    const tickets = (await kitchen.get("/kitchen/tickets")).body.tickets as {
      source: string;
      tableName: string | null;
      orderId: string;
    }[];
    expect(tickets.find((t) => t.orderId === dineIn.body.id)).toMatchObject({
      source: "STAFF_POS",
      tableName: "A-1",
    });
    expect(tickets.some((t) => t.source === "ONLINE_PICKUP")).toBe(true);
    // Online lines can never be edited/voided through the table endpoints.
    const detail = (await cashier.get(`/online-orders/${placed.onlineOrderId}`)).body;
    const voidAttempt = await cashier.post(`/order-items/${detail.items[0].id}/void`, {
      reason: "x",
    });
    expect(voidAttempt.body.error.code).toBe("not_a_table_order");
    // The table bill contains only table orders.
    const bill = (await cashier.get(`/sessions/${session.id}/bill`)).body;
    expect(bill.totalYen).toBe(980);
  });
});
