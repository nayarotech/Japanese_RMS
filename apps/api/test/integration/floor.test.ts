/**
 * Floor (waiter) dashboard against real PostgreSQL (RLS on) and the HTTP API:
 * kitchen-ready food appears, partial readiness, per-item notes, several orders per table, pickup acknowledgement,
 * serving (single and batch across tickets), duplicate/concurrent actions, reconnection (state comes from the DB),
 * closed sessions, tenant and branch isolation, and permissions.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantFixture } from "../../src/infrastructure/database/fixtures.js";
import { withTenantTransaction } from "../../src/infrastructure/database/db.js";
import { getFloorBoard, serveFloorItems } from "../../src/modules/kitchen/index.js";
import type { StaffContext } from "../../src/shared/types/access-context.js";
import { type StaffClient, idem, loginStaff } from "../helpers/clients.js";
import { type Harness, TEST_PASSWORD, createHarness } from "../helpers/harness.js";

let h: Harness;
let A: TenantFixture; // Basic plan: Floor is part of dine-in operations
let B: TenantFixture;
let waiter: StaffClient;
let waiter2: StaffClient; // a second waiter device (the manager, who also has floor.serve)
let kitchen: StaffClient;
let cashier: StaffClient;
let waiterB: StaffClient;

type Item = {
  kitchenItemId: string;
  ticketId: string;
  orderNo: number;
  tableSessionId: string;
  tableName: string;
  nameEn: string | null;
  quantity: number;
  note: string | null;
  status: string;
  readyAt: string | null;
  pickedUp: { byUserId: string; byName: string } | null;
};
type Board = {
  counts: { ready: number; preparing: number; activeTables: number };
  ready: Item[];
  preparing: Item[];
  tables: {
    tableSessionId: string;
    tableName: string;
    readyCount: number;
    preparingCount: number;
    servedCount: number;
  }[];
};

const menu = (name: string) => A.menu.find((m) => m.nameEn === name)!;
const board = async (c: StaffClient = waiter) => {
  const res = await c.get("/floor/board");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Board;
};

async function seat(tableIndex: number) {
  const res = await waiter.post(`/tables/${A.tables[tableIndex]!.id}/sessions`, { guestCount: 2 });
  expect(res.status).toBe(201);
  return res.body.session.id as string;
}
async function order(
  sessionId: string,
  items: { name: string; quantity: number; note?: string }[],
) {
  const res = await waiter.post(
    `/sessions/${sessionId}/orders`,
    {
      items: items.map((i) => ({
        menuItemId: menu(i.name).id,
        quantity: i.quantity,
        note: i.note ?? null,
      })),
    },
    idem(),
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const tickets = (await kitchen.get("/kitchen/tickets")).body.tickets as {
    id: string;
    orderId: string;
    items: { id: string; nameEn: string; note: string | null }[];
  }[];
  return tickets.find((t) => t.orderId === res.body.id)!;
}
const kitchenDo = (path: string) => kitchen.post(path);

beforeAll(async () => {
  h = await createHarness();
  [A, B] = await Promise.all([h.fixture(), h.fixture()]);
  [waiter, waiter2, kitchen, cashier, waiterB] = await Promise.all([
    loginStaff(h.app, A.users.waiter.email, TEST_PASSWORD),
    loginStaff(h.app, A.users.manager.email, TEST_PASSWORD),
    loginStaff(h.app, A.users.kitchen.email, TEST_PASSWORD),
    loginStaff(h.app, A.users.cashier.email, TEST_PASSWORD),
    loginStaff(h.app, B.users.waiter.email, TEST_PASSWORD),
  ]);
});
afterAll(async () => h.close());

describe("Floor board: what is ready, what is preparing", () => {
  let session = "";
  let ticket: Awaited<ReturnType<typeof order>>;

  it("starts empty, then shows a new order as preparing (not ready) on an active table", async () => {
    const empty = await board();
    expect(empty.counts).toEqual({ ready: 0, preparing: 0, activeTables: 0 });

    session = await seat(2); // A-3
    ticket = await order(session, [
      { name: "Shoyu ramen", quantity: 1, note: "Less spicy" },
      { name: "Shoyu ramen", quantity: 1, note: "Extra noodles" },
      { name: "Green tea", quantity: 1 },
      { name: "Karaage set meal", quantity: 1 },
    ]);
    const b = await board();
    expect(b.ready).toHaveLength(0);
    expect(b.preparing).toHaveLength(4);
    // The kitchen starts on receipt: nothing waits in a "new" state.
    expect(b.preparing.every((i) => i.status === "preparing")).toBe(true);
    expect(b.counts).toEqual({ ready: 0, preparing: 4, activeTables: 1 });
    expect(b.tables[0]).toMatchObject({ tableName: "A-3", readyCount: 0, preparingCount: 4 });
    // Two ramen with different requests stay two separate items.
    const notes = b.preparing
      .filter((i) => i.nameEn === "Shoyu ramen")
      .map((i) => i.note)
      .sort();
    expect(notes).toEqual(["Extra noodles", "Less spicy"]);
  });

  it("partial readiness: only the items the kitchen marked ready become waiter tasks", async () => {
    const ramen = ticket.items.filter((i) => i.nameEn === "Shoyu ramen");
    const tea = ticket.items.find((i) => i.nameEn === "Green tea")!;
    for (const i of [...ramen, tea])
      expect((await kitchenDo(`/kitchen/items/${i.id}/ready`)).status).toBe(200);

    const b = await board();
    expect(b.ready.map((i) => i.nameEn).sort()).toEqual([
      "Green tea",
      "Shoyu ramen",
      "Shoyu ramen",
    ]);
    expect(b.preparing.map((i) => i.nameEn)).toEqual(["Karaage set meal"]);
    expect(b.preparing[0]!.status).toBe("preparing");
    expect(b.counts).toMatchObject({ ready: 3, preparing: 1 });
    // Notes stay on the right items.
    const lessSpicy = ramen.find((i) => i.note === "Less spicy")!;
    expect(b.ready.find((i) => i.kitchenItemId === lessSpicy.id)?.note).toBe("Less spicy");
    expect(b.ready[0]).toMatchObject({ tableName: "A-3", orderNo: expect.any(Number) });
    expect(b.ready[0]!.readyAt).toEqual(expect.any(String));
  });

  it("a second order from the same table keeps its own identity", async () => {
    const second = await order(session, [{ name: "Matcha ice cream", quantity: 2 }]);
    await kitchenDo(`/kitchen/tickets/${second.id}/ready`);
    const b = await board();
    const tickets = new Set(b.ready.map((i) => i.ticketId));
    expect(tickets.size).toBe(2);
    expect(new Set(b.ready.map((i) => i.orderNo)).size).toBe(2);
    expect(b.tables.find((t) => t.tableSessionId === session)?.readyCount).toBe(5);
  });

  it("pickup acknowledgement: the item stays ready, other waiters see who has it, duplicates are rejected", async () => {
    const b = await board();
    const tea = b.ready.find((i) => i.nameEn === "Green tea")!;
    const first = await waiter.post("/floor/items/pickup", { kitchenItemIds: [tea.kitchenItemId] });
    expect(first.status).toBe(200);
    expect(first.body.pickedUp).toEqual([tea.kitchenItemId]);
    // Same waiter again: idempotent no-op.
    const again = await waiter.post("/floor/items/pickup", { kitchenItemIds: [tea.kitchenItemId] });
    expect(again.body.pickedUp).toEqual([]);
    // Another waiter cannot pick up the same food.
    const other = await waiter2.post("/floor/items/pickup", {
      kitchenItemIds: [tea.kitchenItemId],
    });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("already_picked_up");

    const seen = (await board(waiter2)).ready.find((i) => i.kitchenItemId === tea.kitchenItemId)!;
    expect(seen.status).toBe("ready");
    expect(seen.pickedUp).toMatchObject({
      byUserId: A.users.waiter.id,
      byName: expect.any(String),
    });
    // The kitchen still shows the item as ready (state machine unchanged).
    const kt = (await kitchen.get("/kitchen/tickets")).body.tickets as {
      items: { id: string; status: string }[];
    }[];
    expect(kt.flatMap((t) => t.items).find((i) => i.id === tea.kitchenItemId)?.status).toBe(
      "ready",
    );
  });

  it("cannot pick up or serve food that is still preparing", async () => {
    const karaage = (await board()).preparing[0]!;
    const pick = await waiter.post("/floor/items/pickup", {
      kitchenItemIds: [karaage.kitchenItemId],
    });
    expect(pick.status).toBe(409);
    const serve = await waiter.post("/floor/items/serve", {
      kitchenItemIds: [karaage.kitchenItemId],
    });
    expect(serve.status).toBe(409);
    expect(serve.body.error.code).toBe("invalid_kitchen_transition");
  });

  it("serving targets exactly the chosen items across tickets, without touching food still preparing", async () => {
    const b = await board();
    const ids = b.ready.filter((i) => i.nameEn !== "Matcha ice cream").map((i) => i.kitchenItemId);
    const res = await waiter.post("/floor/items/serve", { kitchenItemIds: ids });
    expect(res.status).toBe(200);
    const after = await board();
    expect(after.ready.map((i) => i.nameEn)).toEqual(["Matcha ice cream"]);
    expect(after.preparing.map((i) => i.nameEn)).toEqual(["Karaage set meal"]);
    expect(after.preparing[0]!.status).toBe("preparing");
    expect(after.tables[0]).toMatchObject({ readyCount: 2, preparingCount: 1, servedCount: 3 });
    // The kitchen ticket is NOT served while Karaage is preparing; guests see their items served.
    const kt = (await kitchen.get("/kitchen/tickets")).body.tickets as {
      id: string;
      status: string;
    }[];
    expect(kt.find((t) => t.id === ticket.id)?.status).toBe("preparing");
    const pos = await cashier.get(`/sessions/${session}`);
    const statuses = (
      pos.body.orders as { items: { kitchenStatus: string; note: string | null }[] }[]
    )
      .flatMap((o) => o.items)
      .map((i) => i.kitchenStatus);
    expect(statuses.filter((s) => s === "served")).toHaveLength(3);
    // Served events reach the floor, kitchen and staff rooms through the outbox.
    const events = await h.relayDb
      .selectFrom("outbox_events")
      .select("event_type")
      .where("tenant_id", "=", A.tenantId)
      .execute();
    expect(events.map((e) => e.event_type)).toEqual(
      expect.arrayContaining([
        "waiter.food.served",
        "waiter.food.picked_up",
        "kitchen.item.status_changed",
      ]),
    );
  });

  it("duplicate serving is rejected all-or-nothing", async () => {
    const tea = await h.asTenant(A.tenantId, (tx) =>
      tx
        .selectFrom("kitchen_ticket_items")
        .select(["id", "status"])
        .where("ticket_id", "=", ticket.id)
        .where("name_en", "=", "Green tea")
        .executeTakeFirstOrThrow(),
    );
    expect(tea.status).toBe("served");
    const matcha = (await board()).ready[0]!;
    const res = await waiter.post("/floor/items/serve", {
      kitchenItemIds: [tea.id, matcha.kitchenItemId],
    });
    expect(res.status).toBe(409);
    // The ready dessert was NOT served by the rejected request.
    expect((await board()).ready.map((i) => i.kitchenItemId)).toContain(matcha.kitchenItemId);
  });

  it("concurrent waiters: exactly one serve succeeds, the item is served once", async () => {
    const matcha = (await board()).ready[0]!;
    const [a, b] = await Promise.all([
      waiter.post("/floor/items/serve", { kitchenItemIds: [matcha.kitchenItemId] }),
      waiter2.post(`/floor/items/${matcha.kitchenItemId}/serve`),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const audits = await h.asTenant(A.tenantId, (tx) =>
      tx
        .selectFrom("audit_events")
        .select("metadata")
        .where("action", "=", "kitchen.items_served")
        .execute(),
    );
    const servedTimes = audits.filter((x) =>
      JSON.stringify(x.metadata).includes(matcha.kitchenItemId),
    ).length;
    expect(servedTimes).toBe(1);
  });

  it("reconnection: a device that missed every event gets the outstanding tasks from the board", async () => {
    // The karaage becomes ready while "offline"; a fresh read returns it.
    const karaage = (await board()).preparing[0]!;
    await kitchenDo(`/kitchen/items/${karaage.kitchenItemId}/ready`);
    const fresh = await loginStaff(h.app, A.users.waiter.email, TEST_PASSWORD);
    const b = await board(fresh);
    expect(b.ready.map((i) => i.kitchenItemId)).toContain(karaage.kitchenItemId);
    // The legacy reconciliation endpoint agrees.
    const legacy = await fresh.get("/floor/ready-items");
    expect(legacy.body.items.map((i: { kitchenItemId: string }) => i.kitchenItemId)).toContain(
      karaage.kitchenItemId,
    );
  });

  it("closed sessions do not keep service tasks, and their food can no longer be served", async () => {
    const karaage = (await board()).ready[0]!;
    const bill = (await cashier.get(`/sessions/${session}/bill`)).body;
    const paid = await cashier.post(
      `/sessions/${session}/checkout/cash`,
      { amountReceivedYen: 20_000, expectedTotalYen: bill.totalYen },
      idem(),
    );
    expect(paid.status).toBe(201);
    const b = await board();
    expect(b.counts).toEqual({ ready: 0, preparing: 0, activeTables: 0 });
    expect((await waiter.get("/floor/ready-items")).body.items).toHaveLength(0);
    const late = await waiter.post("/floor/items/serve", {
      kitchenItemIds: [karaage.kitchenItemId],
    });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("session_closed");
  });
});

describe("Floor security", () => {
  let readyId = "";

  beforeAll(async () => {
    const session = await seat(4);
    const t = await order(session, [{ name: "Edamame", quantity: 1 }]);
    await kitchenDo(`/kitchen/tickets/${t.id}/ready`);
    readyId = t.items[0]!.id;
  });

  it("other tenants see nothing and cannot act on these items", async () => {
    const b = await board(waiterB);
    expect(b.ready).toHaveLength(0);
    expect((await waiterB.post("/floor/items/serve", { kitchenItemIds: [readyId] })).status).toBe(
      404,
    );
    expect((await waiterB.post("/floor/items/pickup", { kitchenItemIds: [readyId] })).status).toBe(
      404,
    );
  });

  it("other branches of the SAME tenant see nothing and cannot serve (location scoping)", async () => {
    const other = await h.asTenant(A.tenantId, (tx) =>
      tx
        .insertInto("locations")
        .values({ tenant_id: A.tenantId, name: "Second branch" })
        .returning("id")
        .executeTakeFirstOrThrow(),
    );
    const ctx: StaffContext = {
      kind: "staff",
      sessionId: "00000000-0000-0000-0000-000000000000",
      userId: A.users.waiter.id,
      displayName: "Waiter",
      tenantId: A.tenantId,
      locationId: other.id,
      role: "waiter",
      permissions: new Set(["floor.view", "floor.serve"]),
      requestId: "test",
      ip: null,
    };
    const b = await withTenantTransaction(h.deps.db, ctx, (tx) => getFloorBoard(tx, other.id));
    expect(b.ready).toHaveLength(0);
    await expect(
      withTenantTransaction(h.deps.db, ctx, (tx) => serveFloorItems(tx, ctx, [readyId])),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("roles without floor permissions cannot read or change serving status", async () => {
    expect((await kitchen.get("/floor/board")).status).toBe(403);
    expect((await kitchen.post("/floor/items/serve", { kitchenItemIds: [readyId] })).status).toBe(
      403,
    );
    // Cashiers may look at the floor but not serve.
    expect((await cashier.get("/floor/board")).status).toBe(200);
    expect((await cashier.post("/floor/items/serve", { kitchenItemIds: [readyId] })).status).toBe(
      403,
    );
    expect((await cashier.post("/floor/items/pickup", { kitchenItemIds: [readyId] })).status).toBe(
      403,
    );
  });

  it("validates input: strict body, uuids, 1 to 50 items", async () => {
    expect((await waiter.post("/floor/items/serve", { kitchenItemIds: [] })).status).toBe(400);
    expect((await waiter.post("/floor/items/serve", { kitchenItemIds: ["x"] })).status).toBe(400);
    expect(
      (await waiter.post("/floor/items/serve", { kitchenItemIds: [readyId], tenantId: B.tenantId }))
        .status,
    ).toBe(400);
    const many = Array.from({ length: 51 }, () => readyId);
    expect((await waiter.post("/floor/items/serve", { kitchenItemIds: many })).status).toBe(400);
  });

  it("the board carries no money or customer data", async () => {
    const raw = JSON.stringify((await waiter.get("/floor/board")).body);
    expect(raw).not.toMatch(/Yen|price|total|phone|email/i);
  });
});
