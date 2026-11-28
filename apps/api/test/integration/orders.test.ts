/** Ordering rules: idempotency, server-side prices, per-item notes, edit/void permissions. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantFixture } from "../../src/infrastructure/database/fixtures.js";
import { type StaffClient, joinAsGuest, loginStaff } from "../helpers/clients.js";
import { type Harness, TEST_PASSWORD, createHarness } from "../helpers/harness.js";

let h: Harness;
let f: TenantFixture;
let cashier: StaffClient;
let waiter: StaffClient;
let manager: StaffClient;

beforeAll(async () => {
  h = await createHarness();
  f = await h.fixture();
  [cashier, waiter, manager] = await Promise.all([
    loginStaff(h.app, f.users.cashier.email, TEST_PASSWORD),
    loginStaff(h.app, f.users.waiter.email, TEST_PASSWORD),
    loginStaff(h.app, f.users.manager.email, TEST_PASSWORD),
  ]);
});
afterAll(async () => h.close());

async function openTable(index: number) {
  const res = await cashier.post(`/tables/${f.tables[index]!.id}/sessions`, { guestCount: 2 });
  expect(res.status).toBe(201);
  return res.body.session as { id: string };
}
const menu = (i: number) => f.menu[i]!;

describe("idempotent order submission", () => {
  it("replays the same order for a duplicate key and creates exactly one order", async () => {
    const s = await openTable(0);
    const key = randomUUID();
    const body = { items: [{ menuItemId: menu(0).id, quantity: 2 }] };
    const [a, b] = await Promise.all([
      cashier.post(`/sessions/${s.id}/orders`, body, { "Idempotency-Key": key }),
      cashier.post(`/sessions/${s.id}/orders`, body, { "Idempotency-Key": key }),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.id).toBe(b.body.id);
    const count = await h.asTenant(f.tenantId, (tx) =>
      tx
        .selectFrom("orders")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .where("table_session_id", "=", s.id)
        .executeTakeFirstOrThrow(),
    );
    expect(Number(count.n)).toBe(1);

    const reuse = await cashier.post(
      `/sessions/${s.id}/orders`,
      { items: [{ menuItemId: menu(1).id, quantity: 1 }] },
      { "Idempotency-Key": key },
    );
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.code).toBe("idempotency_key_reused");
  });

  it("guest duplicate submission (double tap) is also idempotent", async () => {
    await openTable(1);
    const guest = await joinAsGuest(h.app, f.tables[1]!.qrToken);
    const key = randomUUID();
    const a = await guest.order([{ menuItemId: menu(0).id, quantity: 1, note: "No onion" }], key);
    const b = await guest.order([{ menuItemId: menu(0).id, quantity: 1, note: "No onion" }], key);
    expect(a.status).toBe(201);
    expect(b.headers["idempotent-replayed"]).toBe("true");
    expect(b.body.id).toBe(a.body.id);
  });

  it("requires an Idempotency-Key", async () => {
    const s = await openTable(2);
    const res = await cashier.post(`/sessions/${s.id}/orders`, {
      items: [{ menuItemId: menu(0).id, quantity: 1 }],
    });
    expect(res.status).toBe(400);
  });
});

describe("server-authoritative prices and validation", () => {
  it("rejects client-supplied prices (unknown fields) and unknown items", async () => {
    const s = await openTable(3);
    const tampered = await cashier.post(
      `/sessions/${s.id}/orders`,
      { items: [{ menuItemId: menu(0).id, quantity: 1, unitPriceYen: 1 }] },
      { "Idempotency-Key": randomUUID() },
    );
    expect(tampered.status).toBe(400);
    const unknown = await cashier.post(
      `/sessions/${s.id}/orders`,
      { items: [{ menuItemId: randomUUID(), quantity: 1 }] },
      { "Idempotency-Key": randomUUID() },
    );
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe("item_not_found");
  });

  it("rejects sold-out items and keeps notes as inert, normalized text", async () => {
    await manager.patch(`/menu/items/${menu(4).id}/availability`, { isAvailable: false });
    const s = await openTable(4);
    const soldOut = await cashier.post(
      `/sessions/${s.id}/orders`,
      { items: [{ menuItemId: menu(4).id, quantity: 1 }] },
      { "Idempotency-Key": randomUUID() },
    );
    expect(soldOut.body.error.code).toBe("item_unavailable");
    await manager.patch(`/menu/items/${menu(4).id}/availability`, { isAvailable: true });

    const html = await cashier.post(
      `/sessions/${s.id}/orders`,
      { items: [{ menuItemId: menu(0).id, quantity: 1, note: "  <b>no\nonion</b>‮  " }] },
      { "Idempotency-Key": randomUUID() },
    );
    expect(html.status).toBe(201);
    expect(html.body.items[0].note).toBe("<b>no onion</b>");
    const tooLong = await cashier.post(
      `/sessions/${s.id}/orders`,
      { items: [{ menuItemId: menu(0).id, quantity: 1, note: "x".repeat(141) }] },
      { "Idempotency-Key": randomUUID() },
    );
    expect(tooLong.status).toBe(400);
  });
});

describe("editing and voiding", () => {
  it("sent items are in preparation at once: floor staff cannot edit or void them; a manager voids with a reason", async () => {
    const s = await openTable(5);
    const order = await waiter.post(
      `/sessions/${s.id}/orders`,
      {
        items: [
          { menuItemId: menu(1).id, quantity: 1 },
          { menuItemId: menu(2).id, quantity: 1 },
        ],
      },
      { "Idempotency-Key": randomUUID() },
    );
    const [first, second] = order.body.items as {
      id: string;
      version: number;
      kitchenItemId: string;
    }[];

    // The kitchen started both items on receipt: waiters can no longer edit or void them.
    const edit = await waiter.patch(`/order-items/${first!.id}`, {
      version: first!.version,
      quantity: 2,
      note: "Less spicy",
    });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe("item_in_preparation");
    const lateEdit = await waiter.patch(`/order-items/${second!.id}`, {
      version: second!.version,
      quantity: 2,
    });
    expect(lateEdit.body.error.code).toBe("item_in_preparation");
    const waiterVoid = await waiter.post(`/order-items/${second!.id}/void`, {
      reason: "Customer changed mind",
    });
    expect(waiterVoid.status).toBe(403);
    const noReason = await manager.post(`/order-items/${second!.id}/void`, {});
    expect(noReason.status).toBe(400);
    const managerVoid = await manager.post(`/order-items/${second!.id}/void`, {
      reason: "Customer changed mind",
    });
    expect(managerVoid.status).toBe(204);

    const bill = (await cashier.get(`/sessions/${s.id}/bill`)).body;
    expect(bill.lines).toHaveLength(1);
    expect(bill.totalYen).toBe(menu(1).priceYen);

    const audit = await h.asTenant(f.tenantId, (tx) =>
      tx
        .selectFrom("audit_events")
        .select(["action", "actor_id", "metadata"])
        .where("target_id", "=", second!.id)
        .execute(),
    );
    expect(audit).toEqual([
      expect.objectContaining({ action: "order_item.voided", actor_id: f.users.manager.id }),
    ]);
  });

  it("staff POS and QR orders share one implementation and differ only by source", async () => {
    const s = await openTable(6);
    const guest = await joinAsGuest(h.app, f.tables[6]!.qrToken);
    await guest.order([{ menuItemId: menu(0).id, quantity: 1 }]);
    await cashier.post(
      `/sessions/${s.id}/orders`,
      { items: [{ menuItemId: menu(0).id, quantity: 1 }] },
      { "Idempotency-Key": randomUUID() },
    );
    const view = (await cashier.get(`/sessions/${s.id}`)).body;
    expect(view.orders.map((o: { source: string }) => o.source).sort()).toEqual([
      "STAFF_POS",
      "TABLE_QR",
    ]);
    expect(view.orders[0].items[0].unitPriceYen).toBe(view.orders[1].items[0].unitPriceYen);
  });

  it("bill requested pauses ordering until reopened", async () => {
    const s = await openTable(7);
    await cashier.post(`/sessions/${s.id}/request-bill`);
    const blocked = await cashier.post(
      `/sessions/${s.id}/orders`,
      { items: [{ menuItemId: menu(0).id, quantity: 1 }] },
      { "Idempotency-Key": randomUUID() },
    );
    expect(blocked.body.error.code).toBe("session_checkout_in_progress");
    await cashier.post(`/sessions/${s.id}/reopen`);
    const ok = await cashier.post(
      `/sessions/${s.id}/orders`,
      { items: [{ menuItemId: menu(0).id, quantity: 1 }] },
      { "Idempotency-Key": randomUUID() },
    );
    expect(ok.status).toBe(201);
  });
});
