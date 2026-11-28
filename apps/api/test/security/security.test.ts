/**
 * Security verification: tenant isolation (HTTP + RLS), staff permissions, CSRF/Origin, entitlements,
 * QR credential expiry/revocation/lockout, rate limiting, safe errors.
 */
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantFixture } from "../../src/infrastructure/database/fixtures.js";
import { type StaffClient, joinAsGuest, loginStaff } from "../helpers/clients.js";
import { type Harness, ORIGIN, TEST_PASSWORD, createHarness } from "../helpers/harness.js";

let h: Harness;
let A: TenantFixture;
let B: TenantFixture;
let aCashier: StaffClient;
let aKitchen: StaffClient;
let aWaiter: StaffClient;
let bOwner: StaffClient;
let aSessionId: string;
let aOrderItemId: string;
let aKitchenItemId: string;

beforeAll(async () => {
  h = await createHarness();
  A = await h.fixture();
  B = await h.fixture();
  [aCashier, aKitchen, aWaiter, bOwner] = await Promise.all([
    loginStaff(h.app, A.users.cashier.email, TEST_PASSWORD),
    loginStaff(h.app, A.users.kitchen.email, TEST_PASSWORD),
    loginStaff(h.app, A.users.waiter.email, TEST_PASSWORD),
    loginStaff(h.app, B.users.owner.email, TEST_PASSWORD),
  ]);
  const s = await aCashier.post(`/tables/${A.tables[0]!.id}/sessions`, { guestCount: 2 });
  aSessionId = s.body.session.id;
  const o = await aCashier.post(
    `/sessions/${aSessionId}/orders`,
    { items: [{ menuItemId: A.menu[0]!.id, quantity: 1 }] },
    { "Idempotency-Key": randomUUID() },
  );
  aOrderItemId = o.body.items[0].id;
  aKitchenItemId = o.body.items[0].kitchenItemId;
});
afterAll(async () => h.close());

describe("cross-tenant isolation over HTTP (tenant B owner attacking tenant A ids)", () => {
  it.each([
    ["GET", () => `/sessions/${aSessionId}`, {}],
    ["GET", () => `/sessions/${aSessionId}/bill`, {}],
    ["POST", () => `/tables/${A.tables[1]!.id}/sessions`, { guestCount: 1 }],
    ["POST", () => `/sessions/${aSessionId}/request-bill`, {}],
    ["POST", () => `/kitchen/items/${aKitchenItemId}/ready`, {}],
    ["POST", () => `/floor/items/${aKitchenItemId}/serve`, {}],
    ["POST", () => `/order-items/${aOrderItemId}/void`, { reason: "attack" }],
    ["GET", () => `/tables/${A.tables[0]!.id}/qr`, {}],
    ["POST", () => `/tables/${A.tables[0]!.id}/qr/rotate`, {}],
  ] as const)("%s %s returns 404 and changes nothing", async (method, path, body) => {
    const res = method === "GET" ? await bOwner.get(path()) : await bOwner.post(path(), body);
    expect(res.status).toBe(404);
  });

  it("cannot order onto tenant A's session or settle it", async () => {
    const order = await bOwner.post(
      `/sessions/${aSessionId}/orders`,
      { items: [{ menuItemId: B.menu[0]!.id, quantity: 1 }] },
      { "Idempotency-Key": randomUUID() },
    );
    expect(order.status).toBe(404);
    const pay = await bOwner.post(
      `/sessions/${aSessionId}/checkout/cash`,
      { amountReceivedYen: 99999, expectedTotalYen: 1 },
      { "Idempotency-Key": randomUUID() },
    );
    expect(pay.status).toBe(404);
    const crossMenu = await aCashier.post(
      `/sessions/${aSessionId}/orders`,
      { items: [{ menuItemId: B.menu[0]!.id, quantity: 1 }] },
      { "Idempotency-Key": randomUUID() },
    );
    expect(crossMenu.status).toBe(422); // B's menu item does not exist for A
    const view = (await aCashier.get(`/sessions/${aSessionId}`)).body;
    expect(view.session.status).toBe("open");
    expect(view.orders).toHaveLength(1);
  });

  it("list endpoints only ever show the caller's own tenant", async () => {
    const tables = (await bOwner.get("/floor/tables")).body.tables as { id: string }[];
    expect(tables.some((t) => A.tables.some((a) => a.id === t.id))).toBe(false);
    const tickets = (await bOwner.get("/kitchen/tickets")).body.tickets as {
      tableSessionId: string;
    }[];
    expect(tickets.some((t) => t.tableSessionId === aSessionId)).toBe(false);
  });
});

describe("row-level security in PostgreSQL (defence in depth)", () => {
  it("without tenant context the runtime role sees zero tenant rows", async () => {
    const rows = await sql<{ n: string }>`SELECT count(*)::text AS n FROM app.orders`.execute(
      h.deps.db,
    );
    expect(rows.rows[0]?.n).toBe("0");
  });
  it("with tenant B context, tenant A rows are invisible and cannot be written", async () => {
    const seen = await h.asTenant(B.tenantId, (tx) =>
      tx.selectFrom("table_sessions").select("id").where("id", "=", aSessionId).execute(),
    );
    expect(seen).toHaveLength(0);
    const updated = await h.asTenant(B.tenantId, (tx) =>
      tx
        .updateTable("table_sessions")
        .set({ guest_count: 99 })
        .where("id", "=", aSessionId)
        .executeTakeFirst(),
    );
    expect(updated.numUpdatedRows).toBe(0n);
    await expect(
      h.asTenant(B.tenantId, (tx) =>
        tx
          .insertInto("restaurant_tables")
          .values({ tenant_id: A.tenantId, location_id: A.locationId, name: "evil", capacity: 1 })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });
  it("financial and audit rows are immutable for the runtime role", async () => {
    await expect(
      h.asTenant(A.tenantId, (tx) => tx.deleteFrom("audit_events").execute()),
    ).rejects.toThrow(/permission denied/);
    await expect(
      h.asTenant(A.tenantId, (tx) =>
        tx.updateTable("payments").set({ amount_due_yen: 1 }).execute(),
      ),
    ).rejects.toThrow(/permission denied/);
  });
  it("the runtime role cannot read the outbox or touch plans/brands", async () => {
    await expect(
      h.asTenant(A.tenantId, (tx) => tx.selectFrom("outbox_events").select("id").execute()),
    ).rejects.toThrow(/permission denied/);
    await expect(
      sql`INSERT INTO app.plans (code, name) VALUES ('hack', 'x')`.execute(h.deps.db),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("staff permission enforcement (backend, per role)", () => {
  it("kitchen staff cannot check out, open tables or order", async () => {
    expect(
      (
        await aKitchen.post(
          `/sessions/${aSessionId}/checkout/cash`,
          { amountReceivedYen: 1, expectedTotalYen: 1 },
          { "Idempotency-Key": randomUUID() },
        )
      ).status,
    ).toBe(403);
    expect(
      (await aKitchen.post(`/tables/${A.tables[2]!.id}/sessions`, { guestCount: 1 })).status,
    ).toBe(403);
    expect((await aKitchen.get("/floor/tables")).status).toBe(403);
  });
  it("waiters cannot check out or manage tables/menu; cashiers cannot run the kitchen or serve", async () => {
    expect(
      (
        await aWaiter.post(
          `/sessions/${aSessionId}/checkout/cash`,
          { amountReceivedYen: 1, expectedTotalYen: 1 },
          { "Idempotency-Key": randomUUID() },
        )
      ).status,
    ).toBe(403);
    expect((await aWaiter.post("/tables", { name: "Z-1", capacity: 2 })).status).toBe(403);
    expect(
      (await aWaiter.patch(`/menu/items/${A.menu[0]!.id}/availability`, { isAvailable: false }))
        .status,
    ).toBe(403);
    expect((await aCashier.post(`/kitchen/items/${aKitchenItemId}/ready`)).status).toBe(403);
    expect((await aCashier.post(`/floor/items/${aKitchenItemId}/serve`)).status).toBe(403);
  });
  it("unauthenticated and guest credentials cannot reach staff endpoints", async () => {
    expect((await request(h.app).get(`/api/v1/sessions/${aSessionId}`)).status).toBe(401);
    const guest = await joinAsGuest(h.app, A.tables[0]!.qrToken);
    const res = await request(h.app)
      .get(`/api/v1/sessions/${aSessionId}`)
      .set("Cookie", guest.cookie);
    expect(res.status).toBe(401);
    const kitchen = await request(h.app).get("/api/v1/kitchen/tickets").set("Cookie", guest.cookie);
    expect(kitchen.status).toBe(401);
  });
});

describe("CSRF and Origin protection on cookie-authenticated mutations", () => {
  it("rejects a mutation without the CSRF token, with a wrong token, or from a foreign origin", async () => {
    const path = `/api/v1/tables/${A.tables[3]!.id}/sessions`;
    const noToken = await request(h.app)
      .post(path)
      .set("Cookie", aCashier.cookie)
      .set("Origin", ORIGIN)
      .send({ guestCount: 1 });
    expect(noToken.status).toBe(403);
    expect(noToken.body.error.code).toBe("csrf_failed");
    const wrong = await request(h.app)
      .post(path)
      .set("Cookie", aCashier.cookie)
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", bOwner.csrf)
      .send({ guestCount: 1 });
    expect(wrong.status).toBe(403);
    const evil = await request(h.app)
      .post(path)
      .set("Cookie", aCashier.cookie)
      .set("Origin", "https://evil.example")
      .set("X-CSRF-Token", aCashier.csrf)
      .send({ guestCount: 1 });
    expect(evil.status).toBe(403);
  });
  it("guest mutations require the guest CSRF token", async () => {
    const guest = await joinAsGuest(h.app, A.tables[0]!.qrToken);
    const res = await request(h.app)
      .post("/api/v1/public/session/orders")
      .set("Cookie", guest.cookie)
      .set("Origin", ORIGIN)
      .set("Idempotency-Key", randomUUID())
      .send({ items: [{ menuItemId: A.menu[0]!.id, quantity: 1 }] });
    expect(res.status).toBe(403);
  });
});

describe("QR ordering credentials", () => {
  it("scanning a seated table's QR lets a guest order without any code (scan-to-order)", async () => {
    await aCashier.post(`/tables/${A.tables[4]!.id}/sessions`, { guestCount: 2 });
    const guest = await joinAsGuest(h.app, A.tables[4]!.qrToken);
    const res = await guest.order([{ menuItemId: A.menu[0]!.id, quantity: 1 }]);
    expect(res.status).toBe(201);
    const noCookie = await request(h.app)
      .post("/api/v1/public/session/orders")
      .set("Origin", ORIGIN)
      .send({ items: [] });
    expect(noCookie.status).toBe(401);
  });

  it("scanning a FREE table opens its dining session automatically; orders belong to that table", async () => {
    const guest = await joinAsGuest(h.app, A.tables[5]!.qrToken);
    expect((await guest.order([{ menuItemId: A.menu[0]!.id, quantity: 1 }])).status).toBe(201);
    const floor = (await aCashier.get("/floor/tables")).body.tables as {
      id: string;
      state: string;
      session: { itemCount: number } | null;
    }[];
    const t = floor.find((x) => x.id === A.tables[5]!.id);
    expect(t?.state).toBe("occupied");
    expect(t?.session?.itemCount).toBe(1);
    // A second phone at the same table joins the SAME session (no duplicate sessions).
    const second = await joinAsGuest(h.app, A.tables[5]!.qrToken);
    expect((await second.order([{ menuItemId: A.menu[1]!.id, quantity: 1 }])).status).toBe(201);
    const after = (await aCashier.get("/floor/tables")).body.tables as {
      id: string;
      session: { itemCount: number } | null;
    }[];
    expect(after.find((x) => x.id === A.tables[5]!.id)?.session?.itemCount).toBe(2);
  });

  it("an inactive table's QR cannot open a session", async () => {
    const owner = await loginStaff(h.app, A.users.owner.email, TEST_PASSWORD);
    const tables = (await owner.get("/tables")).body.tables as { id: string; version: number }[];
    const t = tables.find((x) => x.id === A.tables[9]!.id)!;
    await owner.patch(`/tables/${t.id}`, { version: t.version, isActive: false });
    const res = await request(h.app)
      .post(`/api/v1/public/tables/${A.tables[9]!.qrToken}/join`)
      .set("Origin", ORIGIN)
      .send({});
    expect(res.status).toBe(409);
  });

  it("staff can sign out all guest phones of a table (revocation)", async () => {
    const s = await aCashier.post(`/tables/${A.tables[6]!.id}/sessions`, { guestCount: 2 });
    const guest = await joinAsGuest(h.app, A.tables[6]!.qrToken);
    expect((await guest.session()).status).toBe(200);
    expect((await aCashier.post(`/sessions/${s.body.session.id}/guests/revoke`)).status).toBe(204);
    expect((await guest.session()).status).toBe(401);
  });

  it("expired guest credentials stop working", async () => {
    const s = await aCashier.post(`/tables/${A.tables[7]!.id}/sessions`, { guestCount: 2 });
    const guest = await joinAsGuest(h.app, A.tables[7]!.qrToken);
    await sql`UPDATE app.guest_sessions SET expires_at = now() - interval '1 minute' WHERE table_session_id = ${s.body.session.id}`.execute(
      h.migratorDb,
    );
    expect((await guest.session()).status).toBe(401);
  });

  it("reissuing a table QR invalidates the old printed code", async () => {
    const owner = await loginStaff(h.app, A.users.owner.email, TEST_PASSWORD);
    const old = A.tables[8]!.qrToken;
    const rotated = await owner.post(`/tables/${A.tables[8]!.id}/qr/rotate`);
    expect(rotated.status).toBe(200);
    expect((await request(h.app).get(`/api/v1/public/tables/${old}`)).status).toBe(404);
    expect((await request(h.app).get(`/api/v1/public/tables/${rotated.body.token}`)).status).toBe(
      200,
    );
  });

  it("a guest is bound to one dining session and the public view exposes no staff data", async () => {
    const guest = await joinAsGuest(h.app, A.tables[0]!.qrToken);
    const view = await guest.session();
    const text = JSON.stringify(view.body);
    expect(text).not.toContain(A.users.cashier.id);
    expect(text).not.toContain("joinCode");
    const pub = await request(h.app).get(`/api/v1/public/tables/${A.tables[0]!.qrToken}`);
    expect(JSON.stringify(pub.body)).not.toMatch(/joinCode|taxRateBp|version|openedBy/);
  });
});

describe("subscription entitlements are enforced server-side", () => {
  it("a suspended subscription disables the dine-in features (fail closed)", async () => {
    const C = await h.fixture({ subscriptionStatus: "suspended" });
    const owner = await loginStaff(h.app, C.users.owner.email, TEST_PASSWORD);
    expect(owner.me).toMatchObject({ role: "owner" });
    const res = await owner.post(`/tables/${C.tables[0]!.id}/sessions`, { guestCount: 1 });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      code: "feature_not_entitled",
      details: { feature: "dine_in_pos" },
    });
    expect((await owner.get("/kitchen/tickets")).body.error.code).toBe("feature_not_entitled");
  });
  it("the Standard plan reuses the same features (no plan-specific implementation)", async () => {
    const D = await h.fixture({ planCode: "standard" });
    const owner = await loginStaff(h.app, D.users.owner.email, TEST_PASSWORD);
    expect(
      (await owner.post(`/tables/${D.tables[0]!.id}/sessions`, { guestCount: 1 })).status,
    ).toBe(201);
  });
});

describe("authentication hardening", () => {
  it("does not reveal whether an email exists and rate-limits login per email", async () => {
    const strict = await createHarness({
      limits: { loginPerEmail: { points: 3, durationSeconds: 60 } },
    });
    try {
      const login = (email: string, password: string) =>
        request(strict.app)
          .post("/api/v1/auth/login")
          .set("Origin", ORIGIN)
          .send({ email, password });
      const unknown = await login("nobody@example.test", "whatever-password");
      const wrong = await login(A.users.cashier.email, "wrong-password");
      expect(unknown.status).toBe(401);
      expect(wrong.status).toBe(401);
      expect(unknown.body.error.code).toBe(wrong.body.error.code);
      await login(A.users.cashier.email, "wrong-password");
      await login(A.users.cashier.email, "wrong-password");
      const limited = await login(A.users.cashier.email, TEST_PASSWORD);
      expect(limited.status).toBe(429);
      expect(limited.headers["retry-after"]).toBeDefined();
    } finally {
      await strict.close();
    }
  });
  it("logout revokes the session server-side and session tokens are stored only as hashes", async () => {
    const c = await loginStaff(h.app, A.users.manager.email, TEST_PASSWORD);
    const token = c.cookie.split("=")[1] ?? "";
    const stored = await h.deps.db.selectFrom("staff_sessions").select("token_hash").execute();
    expect(stored.some((s) => s.token_hash.toString("utf8").includes(token))).toBe(false);
    expect((await c.post("/auth/logout")).status).toBe(204);
    expect((await c.get("/auth/me")).status).toBe(401);
  });
  it("errors never leak stack traces or SQL", async () => {
    const res = await aCashier.get("/sessions/not-a-uuid");
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/stack|select|at \w+ \(/i);
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});
