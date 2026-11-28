import { describe, expect, it } from "vitest";
import { routeEvent } from "./relay.js";

const base = { id: "1", tenant_id: "T", location_id: "L" };

describe("routeEvent", () => {
  it("sends kitchen tickets only to the kitchen room of that tenant/location", () => {
    const d = routeEvent({
      ...base,
      event_type: "kitchen.ticket.created",
      payload: { ticketId: "k", tableSessionId: "S", tableName: "A-1" },
    });
    expect(d).toEqual([{ rooms: ["t:T:l:L:kitchen"], payload: expect.any(Object) }]);
  });
  it("sends food-ready to the assigned waiter only, else to floor staff", () => {
    const assigned = routeEvent({
      ...base,
      event_type: "waiter.food.ready",
      payload: { tableSessionId: "S", assignedWaiterId: "U", items: [] },
    });
    expect(assigned[0]?.rooms).toEqual(["t:T:u:U"]);
    const unassigned = routeEvent({
      ...base,
      event_type: "waiter.food.ready",
      payload: { tableSessionId: "S", assignedWaiterId: null, items: [] },
    });
    expect(unassigned[0]?.rooms).toEqual(["t:T:l:L:floor"]);
  });
  it("sends pickup acknowledgements to floor, kitchen and staff of that location only (never guests)", () => {
    const d = routeEvent({
      ...base,
      event_type: "waiter.food.picked_up",
      payload: { ticketId: "k", tableSessionId: "S", kitchenItemIds: ["i"] },
    });
    expect(d).toEqual([
      { rooms: ["t:T:l:L:floor", "t:T:l:L:kitchen", "t:T:l:L:staff"], payload: expect.any(Object) },
    ]);
  });
  it("gives guests only an id-only refresh hint for their own session", () => {
    const d = routeEvent({
      ...base,
      event_type: "order.created",
      payload: {
        orderId: "o",
        tableSessionId: "S",
        tableName: "A-1",
        source: "TABLE_QR",
        itemCount: 2,
        orderNo: 7,
      },
    });
    expect(d).toContainEqual({ rooms: ["t:T:ts:S:guest"], payload: { tableSessionId: "S" } });
  });
  it("drops unknown events and events without a location", () => {
    expect(routeEvent({ ...base, event_type: "unknown", payload: {} })).toEqual([]);
    expect(
      routeEvent({ ...base, location_id: null, event_type: "order.created", payload: {} }),
    ).toEqual([]);
  });
  it("routes online orders to online staff, and only id-only hints to that order's customer", () => {
    const payload = {
      onlineOrderId: "O",
      orderNo: 418,
      fulfillmentType: "delivery",
      status: "accepted",
      paymentStatus: "unpaid",
    };
    expect(routeEvent({ ...base, event_type: "online.order.created", payload })).toEqual([
      { rooms: ["t:T:l:L:online"], payload },
    ]);
    expect(routeEvent({ ...base, event_type: "online.order.accepted", payload })).toEqual([
      { rooms: ["t:T:l:L:online"], payload },
      { rooms: ["t:T:oo:O:customer"], payload: { onlineOrderId: "O" } },
    ]);
  });
  it("never sends online kitchen activity to a table's guests", () => {
    const d = routeEvent({
      ...base,
      event_type: "kitchen.item.status_changed",
      payload: {
        ticketId: "k",
        tableSessionId: null,
        kitchenItemIds: [],
        status: "ready",
        ticketStatus: "ready",
      },
    });
    expect(d.flatMap((x) => x.rooms).some((r) => r.includes(":ts:"))).toBe(false);
  });
});
