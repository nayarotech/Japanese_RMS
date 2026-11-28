/**
 * The complete dine-in workflow, end to end, against real PostgreSQL (RLS on) and the real HTTP API:
 * seat -> QR join -> two ramen with different notes -> POS + kitchen see it -> partial ready ->
 * waiter alert + serve -> additional order -> combined bill -> cash checkout -> table free again.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantFixture } from "../../src/infrastructure/database/fixtures.js";
import {
  type GuestClient,
  type StaffClient,
  idem,
  joinAsGuest,
  loginStaff,
} from "../helpers/clients.js";
import { type Harness, TEST_PASSWORD, createHarness } from "../helpers/harness.js";

let h: Harness;
let f: TenantFixture;
let cashier: StaffClient;
let waiter: StaffClient;
let kitchen: StaffClient;
let guest: GuestClient;

const item = (name: string) => {
  const m = f.menu.find((x) => x.nameEn === name);
  if (!m) throw new Error(`menu item ${name} missing`);
  return m;
};

beforeAll(async () => {
  h = await createHarness();
  f = await h.fixture();
  cashier = await loginStaff(h.app, f.users.cashier.email, TEST_PASSWORD);
  waiter = await loginStaff(h.app, f.users.waiter.email, TEST_PASSWORD);
  kitchen = await loginStaff(h.app, f.users.kitchen.email, TEST_PASSWORD);
});
afterAll(async () => h.close());

async function outboxTypes(
  sinceId = "0",
): Promise<{ id: string; event_type: string; payload: Record<string, unknown> }[]> {
  return h.relayDb
    .selectFrom("outbox_events")
    .select(["id", "event_type", "payload"])
    .where("tenant_id", "=", f.tenantId)
    .where("id", ">", sinceId)
    .orderBy("id")
    .execute();
}

describe("dine-in workflow (Basic package)", () => {
  const table = () => f.tables[2]!; // A-3
  let sessionId = "";
  let firstOrderId = "";

  it("1-3. customer is seated: staff opens a dining session and the table becomes occupied", async () => {
    const res = await waiter.post(`/tables/${table().id}/sessions`, { guestCount: 2 });
    expect(res.status).toBe(201);
    sessionId = res.body.session.id;

    const floor = await cashier.get("/floor/tables");
    const t = floor.body.tables.find((x: { id: string }) => x.id === table().id);
    expect(t.state).toBe("occupied");
    expect(t.session.guestCount).toBe(2);

    // A second session on the same table is impossible (DB partial unique index).
    const dup = await cashier.post(`/tables/${table().id}/sessions`, { guestCount: 1 });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("table_occupied");
  });

  it("4-5. customer scans the QR: menu opens and the phone can order for this seated table", async () => {
    const pub = await (
      await import("supertest")
    )
      .default(h.app)
      .get(`/api/v1/public/tables/${table().qrToken}`);
    expect(pub.status).toBe(200);
    expect(pub.body).toMatchObject({
      table: { name: "A-3" },
      sessionState: "open",
      joined: false,
      orderingEnabled: true,
    });
    expect(pub.body.menu.length).toBeGreaterThan(0);

    guest = await joinAsGuest(h.app, table().qrToken);
    const view = await guest.session();
    expect(view.status).toBe(200);
    expect(view.body.table.name).toBe("A-3");
  });

  it("6-8. customer orders two ramen with DIFFERENT notes; lines stay distinct with server prices", async () => {
    const ramen = item("Shoyu ramen");
    const tea = item("Green tea");
    const since = (await outboxTypes()).at(-1)?.id ?? "0";
    const res = await guest.order([
      { menuItemId: ramen.id, quantity: 1, note: "Less spicy" },
      { menuItemId: ramen.id, quantity: 1, note: "Extra noodles" },
      { menuItemId: tea.id, quantity: 1, note: "No sugar" },
    ]);
    expect(res.status).toBe(201);
    firstOrderId = res.body.id;
    expect(res.body.source).toBe("TABLE_QR");
    const ramenLines = res.body.items.filter(
      (i: { menuItemId: string }) => i.menuItemId === ramen.id,
    );
    expect(ramenLines).toHaveLength(2);
    expect(ramenLines.map((i: { note: string }) => i.note).sort()).toEqual([
      "Extra noodles",
      "Less spicy",
    ]);
    expect(
      ramenLines.every((i: { unitPriceYen: number }) => i.unitPriceYen === ramen.priceYen),
    ).toBe(true);

    // Order, kitchen ticket and events were committed together.
    const types = (await outboxTypes(since)).map((e) => e.event_type);
    expect(types).toEqual(expect.arrayContaining(["order.created", "kitchen.ticket.created"]));
  });

  it("9. the order appears on the cashier POS (session view) with notes", async () => {
    const res = await cashier.get(`/sessions/${sessionId}`);
    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(1);
    const notes = res.body.orders[0].items.map((i: { note: string | null }) => i.note);
    expect(notes).toEqual(expect.arrayContaining(["Less spicy", "Extra noodles", "No sugar"]));
    expect(res.body.bill.totalYen).toBe(
      item("Shoyu ramen").priceYen * 2 + item("Green tea").priceYen,
    );
  });

  it("10-11. kitchen receives a ticket with item-level notes and can mark items PARTIALLY ready", async () => {
    const res = await kitchen.get("/kitchen/tickets");
    const ticket = res.body.tickets.find((t: { orderId: string }) => t.orderId === firstOrderId);
    // The kitchen starts as soon as the order arrives (no separate "new" step).
    expect(ticket).toMatchObject({ tableName: "A-3", status: "preparing", source: "TABLE_QR" });
    expect(ticket.items.map((i: { note: string }) => i.note).sort()).toEqual([
      "Extra noodles",
      "Less spicy",
      "No sugar",
    ]);

    expect(ticket.items.every((i: { status: string }) => i.status === "preparing")).toBe(true);

    // Only the "Less spicy" ramen is ready: the ticket must NOT become ready.
    const lessSpicy = ticket.items.find((i: { note: string }) => i.note === "Less spicy");
    const ready = await kitchen.post(`/kitchen/items/${lessSpicy.id}/ready`);
    expect(ready.status).toBe(200);
    expect(ready.body.ticket.status).toBe("preparing");
    expect(ready.body.ticket.items.find((i: { id: string }) => i.id === lessSpicy.id).status).toBe(
      "ready",
    );

    // Invalid transitions are rejected by the backend (a ready item cannot be marked ready again).
    const again = await kitchen.post(`/kitchen/items/${lessSpicy.id}/ready`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("invalid_kitchen_transition");
  });

  it("12. waiter is notified (outbox) and can reconcile ready items from the backend", async () => {
    const events = await outboxTypes();
    const ready = events.filter((e) => e.event_type === "waiter.food.ready").at(-1);
    expect(ready?.payload).toMatchObject({ tableName: "A-3", assignedWaiterId: f.users.waiter.id });
    expect((ready?.payload["items"] as { note: string }[])[0]?.note).toBe("Less spicy");

    const items = await waiter.get("/floor/ready-items");
    expect(items.status).toBe(200);
    expect(items.body.items).toHaveLength(1);
    expect(items.body.items[0]).toMatchObject({ tableName: "A-3", note: "Less spicy" });
  });

  it("13. waiter serves the ready item; the rest of the ticket is finished and served", async () => {
    const pending = await waiter.get("/floor/ready-items");
    const served = await waiter.post(`/floor/items/${pending.body.items[0].kitchenItemId}/serve`);
    expect(served.status).toBe(200);

    const tickets = (await kitchen.get("/kitchen/tickets")).body.tickets;
    const ticket = tickets.find((t: { orderId: string }) => t.orderId === firstOrderId);
    expect((await kitchen.post(`/kitchen/tickets/${ticket.id}/ready`)).body.ticket.status).toBe(
      "ready",
    );
    const serveAll = await waiter.post(`/floor/tickets/${ticket.id}/serve`);
    expect(serveAll.body.ticket.status).toBe("served");
  });

  it("14-15. additional orders join the SAME session; earlier tickets do not reset", async () => {
    const res = await guest.order([{ menuItemId: item("Matcha ice cream").id, quantity: 1 }]);
    expect(res.status).toBe(201);
    const pos = await cashier.post(
      `/sessions/${sessionId}/orders`,
      { items: [{ menuItemId: item("Shoyu ramen").id, quantity: 1, note: "Extra noodles" }] },
      idem(),
    );
    expect(pos.status).toBe(201);
    expect(pos.body.source).toBe("STAFF_POS");

    const view = await cashier.get(`/sessions/${sessionId}`);
    expect(view.body.orders).toHaveLength(3);
    const firstTicketItems = view.body.orders[0].items.map(
      (i: { kitchenStatus: string }) => i.kitchenStatus,
    );
    expect(firstTicketItems.every((s: string) => s === "served")).toBe(true);

    const open = (await kitchen.get("/kitchen/tickets")).body.tickets.filter(
      (t: { tableSessionId: string }) => t.tableSessionId === sessionId,
    );
    expect(open.map((t: { status: string }) => t.status).sort()).toEqual([
      "preparing",
      "preparing",
    ]);
  });

  it("16. cashier sees the combined bill across all submissions", async () => {
    const bill = (await cashier.get(`/sessions/${sessionId}/bill`)).body;
    const expected =
      item("Shoyu ramen").priceYen * 3 +
      item("Green tea").priceYen +
      item("Matcha ice cream").priceYen;
    expect(bill.lines).toHaveLength(5);
    expect(bill.totalYen).toBe(expected);
    expect(bill.taxBreakdown).toEqual([
      { rateBp: 1000, baseYen: expected, taxYen: Math.floor((expected * 1000) / 11000) },
    ]);
  });

  it("17-18. cash payment settles the bill, closes the session, frees the table, issues a receipt", async () => {
    const bill = (await cashier.get(`/sessions/${sessionId}/bill`)).body;
    const res = await cashier.post(
      `/sessions/${sessionId}/checkout/cash`,
      { amountReceivedYen: 10_000, expectedTotalYen: bill.totalYen },
      idem(),
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      amountDueYen: bill.totalYen,
      amountReceivedYen: 10_000,
      changeYen: 10_000 - bill.totalYen,
    });

    const receipt = await cashier.get(`/receipts/${res.body.receiptId}`);
    expect(receipt.status).toBe(200);
    expect(receipt.body.body).toMatchObject({ tableName: "A-3", totalYen: bill.totalYen });
    expect(receipt.body.body.lines).toHaveLength(5);

    const floor = await cashier.get("/floor/tables");
    expect(floor.body.tables.find((x: { id: string }) => x.id === table().id).state).toBe("free");
    expect((await outboxTypes()).map((e) => e.event_type)).toEqual(
      expect.arrayContaining(["checkout.completed", "table.session.closed"]),
    );
  });

  it("closed sessions accept no orders and the guest credential stops working", async () => {
    const staffOrder = await cashier.post(
      `/sessions/${sessionId}/orders`,
      { items: [{ menuItemId: item("Green tea").id, quantity: 1 }] },
      idem(),
    );
    expect(staffOrder.status).toBe(409);
    expect(staffOrder.body.error.code).toBe("session_closed");
    const guestOrder = await guest.order([{ menuItemId: item("Green tea").id, quantity: 1 }]);
    expect(guestOrder.status).toBe(401);
  });

  it("the table can be reused: the previous party's phone cannot order onto the next party's bill", async () => {
    const res = await waiter.post(`/tables/${table().id}/sessions`, { guestCount: 3 });
    expect(res.status).toBe(201);
    expect(res.body.session.id).not.toBe(sessionId);
    const stale = await guest.order([{ menuItemId: item("Green tea").id, quantity: 1 }]);
    expect(stale.status).toBe(401);
    const next = await joinAsGuest(h.app, table().qrToken);
    const ok = await next.order([{ menuItemId: item("Green tea").id, quantity: 1 }]);
    expect(ok.status).toBe(201);
    const view = (await cashier.get(`/sessions/${res.body.session.id}`)).body;
    expect(view.orders).toHaveLength(1);
  });
});
