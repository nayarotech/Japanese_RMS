/** Financial safety: insufficient cash, duplicate/concurrent checkout, order-vs-checkout race, rollback. */
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantFixture } from "../../src/infrastructure/database/fixtures.js";
import { type StaffClient, loginStaff } from "../helpers/clients.js";
import { type Harness, TEST_PASSWORD, createHarness } from "../helpers/harness.js";

let h: Harness;
let f: TenantFixture;
let cashier: StaffClient;
let cashier2: StaffClient;
let waiter: StaffClient;

beforeAll(async () => {
  h = await createHarness();
  f = await h.fixture();
  cashier = await loginStaff(h.app, f.users.cashier.email, TEST_PASSWORD);
  cashier2 = await loginStaff(h.app, f.users.owner.email, TEST_PASSWORD);
  waiter = await loginStaff(h.app, f.users.waiter.email, TEST_PASSWORD);
});
afterAll(async () => h.close());

async function seatAndOrder(tableIndex: number, quantity = 2) {
  const s = (await cashier.post(`/tables/${f.tables[tableIndex]!.id}/sessions`, { guestCount: 2 }))
    .body.session as { id: string };
  const o = await cashier.post(
    `/sessions/${s.id}/orders`,
    { items: [{ menuItemId: f.menu[0]!.id, quantity }] },
    { "Idempotency-Key": randomUUID() },
  );
  expect(o.status).toBe(201);
  const bill = (await cashier.get(`/sessions/${s.id}/bill`)).body as { totalYen: number };
  return { sessionId: s.id, total: bill.totalYen };
}

describe("cash checkout", () => {
  it("rejects insufficient cash without settling anything", async () => {
    const { sessionId, total } = await seatAndOrder(0);
    const res = await cashier.post(
      `/sessions/${sessionId}/checkout/cash`,
      { amountReceivedYen: total - 1, expectedTotalYen: total },
      { "Idempotency-Key": randomUUID() },
    );
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: "insufficient_cash", details: { shortByYen: 1 } });
    const session = (await cashier.get(`/sessions/${sessionId}`)).body.session;
    expect(session.status).toBe("open");
    // Exact amount works afterwards with change 0.
    const ok = await cashier.post(
      `/sessions/${sessionId}/checkout/cash`,
      { amountReceivedYen: total, expectedTotalYen: total },
      { "Idempotency-Key": randomUUID() },
    );
    expect(ok.status).toBe(201);
    expect(ok.body.changeYen).toBe(0);
  });

  it("duplicate checkout with the same key replays; a different key is rejected", async () => {
    const { sessionId, total } = await seatAndOrder(1);
    const key = randomUUID();
    const body = { amountReceivedYen: 5000, expectedTotalYen: total };
    const a = await cashier.post(`/sessions/${sessionId}/checkout/cash`, body, {
      "Idempotency-Key": key,
    });
    const b = await cashier.post(`/sessions/${sessionId}/checkout/cash`, body, {
      "Idempotency-Key": key,
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.paymentId).toBe(a.body.paymentId);
    const c = await cashier.post(`/sessions/${sessionId}/checkout/cash`, body, {
      "Idempotency-Key": randomUUID(),
    });
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe("session_closed");
  });

  it("two cashiers settling the same table at the same time: exactly one succeeds", async () => {
    const { sessionId, total } = await seatAndOrder(2);
    const body = { amountReceivedYen: 10_000, expectedTotalYen: total };
    const results = await Promise.all([
      cashier.post(`/sessions/${sessionId}/checkout/cash`, body, {
        "Idempotency-Key": randomUUID(),
      }),
      cashier2.post(`/sessions/${sessionId}/checkout/cash`, body, {
        "Idempotency-Key": randomUUID(),
      }),
      cashier.post(`/sessions/${sessionId}/checkout/cash`, body, {
        "Idempotency-Key": randomUUID(),
      }),
    ]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    const count = await h.relayDb
      .selectFrom("outbox_events")
      .select("payload")
      .where("event_type", "=", "checkout.completed")
      .execute();
    expect(count.filter((e) => e.payload["tableSessionId"] === sessionId)).toHaveLength(1);
  });

  it("simultaneous additional order and checkout never settles a bill that nobody reviewed", async () => {
    for (let round = 0; round < 5; round++) {
      const { sessionId, total } = await seatAndOrder(3 + round, 1);
      const [order, checkout] = await Promise.all([
        waiter.post(
          `/sessions/${sessionId}/orders`,
          { items: [{ menuItemId: f.menu[1]!.id, quantity: 1 }] },
          { "Idempotency-Key": randomUUID() },
        ),
        cashier.post(
          `/sessions/${sessionId}/checkout/cash`,
          { amountReceivedYen: 20_000, expectedTotalYen: total },
          { "Idempotency-Key": randomUUID() },
        ),
      ]);
      const view = (await cashier.get(`/sessions/${sessionId}`)).body;
      if (checkout.status === 201) {
        // Checkout won the lock: the late order was rejected and the paid amount equals the final bill.
        expect(order.status).toBe(409);
        expect(order.body.error.code).toBe("session_closed");
        expect(view.session.status).toBe("closed");
        expect(checkout.body.amountDueYen).toBe(view.bill.totalYen);
      } else {
        // Order won: checkout saw a changed bill and refused; table stays open with the new item.
        expect(order.status).toBe(201);
        expect(checkout.status).toBe(409);
        expect(checkout.body.error.code).toBe("bill_changed");
        expect(view.session.status).toBe("open");
        expect(view.bill.totalYen).toBe(total + f.menu[1]!.priceYen);
      }
    }
  });

  it("cannot close a table that still has unpaid items", async () => {
    const { sessionId } = await seatAndOrder(8);
    const res = await cashier.post(`/sessions/${sessionId}/close`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("unpaid_items");
  });

  it("rolls back everything if checkout fails mid-transaction (payment, session, events)", async () => {
    const { sessionId, total } = await seatAndOrder(9);
    // Inject a failure into receipt creation for this session only (test-only trigger, as migrator).
    await sql
      .raw(
        `CREATE OR REPLACE FUNCTION app.test_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN IF NEW.table_session_id = '${sessionId}' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$;
         CREATE TRIGGER test_fail_receipt BEFORE INSERT ON app.receipts FOR EACH ROW EXECUTE FUNCTION app.test_fail_receipt();`,
      )
      .execute(h.migratorDb);
    try {
      const res = await cashier.post(
        `/sessions/${sessionId}/checkout/cash`,
        { amountReceivedYen: 10_000, expectedTotalYen: total },
        { "Idempotency-Key": randomUUID() },
      );
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain("injected"); // no internals leaked
    } finally {
      await sql
        .raw(
          "DROP TRIGGER test_fail_receipt ON app.receipts; DROP FUNCTION app.test_fail_receipt();",
        )
        .execute(h.migratorDb);
    }
    const view = (await cashier.get(`/sessions/${sessionId}`)).body;
    expect(view.session.status).toBe("open");
    const events = await h.relayDb
      .selectFrom("outbox_events")
      .select("payload")
      .where("event_type", "=", "checkout.completed")
      .execute();
    expect(events.some((e) => e.payload["tableSessionId"] === sessionId)).toBe(false);
    const payments = await h.asTenant(f.tenantId, (tx) =>
      tx.selectFrom("payments").select("id").where("table_session_id", "=", sessionId).execute(),
    );
    expect(payments).toHaveLength(0);
    // Retry succeeds once the fault is gone.
    const retry = await cashier.post(
      `/sessions/${sessionId}/checkout/cash`,
      { amountReceivedYen: 10_000, expectedTotalYen: total },
      { "Idempotency-Key": randomUUID() },
    );
    expect(retry.status).toBe(201);
  });
});
