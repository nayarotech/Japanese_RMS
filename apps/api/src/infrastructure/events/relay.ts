/**
 * Outbox relay: reads COMMITTED outbox rows and broadcasts them to authorized rooms via the
 * Socket.IO Redis adapter/emitter. Runs in the worker under the dedicated relay DB role.
 *
 * - `FOR UPDATE SKIP LOCKED` lets several workers run without double-claiming rows.
 * - Delivery is at-least-once; clients de-duplicate and always reconcile from the API.
 * - Redis Pub/Sub is not durable: a missed event is harmless because state lives in PostgreSQL.
 */
import type { Kysely } from "kysely";
import type { Database } from "../database/schema.js";
import { rooms } from "../websocket/rooms.js";
import type { DomainEventType } from "./event-types.js";

export interface RoomEmitter {
  to(room: string | string[]): { emit(event: string, ...args: unknown[]): unknown };
}

export interface OutboxRow {
  id: string;
  tenant_id: string;
  location_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
}

export interface Delivery {
  rooms: string[];
  payload: Record<string, unknown>;
}

/** Pure routing table: which rooms receive which event, and with what payload. */
export function routeEvent(row: OutboxRow): Delivery[] {
  const t = row.tenant_id;
  const l = row.location_id;
  if (!l) return [];
  const staff = rooms.staff(t, l);
  const kitchen = rooms.kitchen(t, l);
  const floor = rooms.floor(t, l);
  const p = row.payload;
  const tableSessionId = typeof p["tableSessionId"] === "string" ? p["tableSessionId"] : null;
  const guest = tableSessionId
    ? [{ rooms: [rooms.guestTable(t, tableSessionId)], payload: { tableSessionId } }]
    : [];
  const onlineOrderId = typeof p["onlineOrderId"] === "string" ? p["onlineOrderId"] : null;
  const onlineStaff = onlineOrderId ? [{ rooms: [rooms.online(t, l)], payload: p }] : [];
  // Customers get an id-only refresh hint for THEIR order only.
  const onlineCustomer = onlineOrderId
    ? [{ rooms: [rooms.onlineCustomer(t, onlineOrderId)], payload: { onlineOrderId } }]
    : [];

  switch (row.event_type as DomainEventType) {
    case "table.session.opened":
    case "table.session.updated":
      return [
        { rooms: [staff, floor], payload: p },
        ...(row.event_type === "table.session.updated" ? guest : []),
      ];
    case "table.session.closed":
    case "checkout.completed":
      return [{ rooms: [staff, floor], payload: p }, ...guest];
    case "order.created":
      return [{ rooms: [staff, floor], payload: p }, ...guest];
    case "order.updated":
      return [{ rooms: [staff, floor, kitchen], payload: p }, ...guest];
    case "kitchen.ticket.created":
      return [{ rooms: [kitchen], payload: p }];
    case "kitchen.item.status_changed":
      return [{ rooms: [kitchen, staff, floor], payload: p }, ...guest];
    case "waiter.food.ready": {
      const assigned = typeof p["assignedWaiterId"] === "string" ? p["assignedWaiterId"] : null;
      return [{ rooms: [assigned ? rooms.user(t, assigned) : floor], payload: p }];
    }
    case "waiter.food.served":
      return [{ rooms: [floor, kitchen, staff], payload: p }];
    case "online.order.created": // the customer placed it; staff need to accept it
      return onlineStaff;
    case "online.order.accepted":
    case "online.order.rejected":
    case "online.order.cancelled":
    case "online.order.preparing":
    case "online.order.ready":
    case "online.order.dispatched":
    case "online.order.delivered":
    case "online.order.completed":
    case "online.order.payment_recorded":
      return [...onlineStaff, ...onlineCustomer];
    default:
      return [];
  }
}

/** Claims and relays one batch. Returns the number of rows processed. */
export async function relayOutboxBatch(
  db: Kysely<Database>,
  emitter: RoomEmitter,
  batchSize = 100,
): Promise<number> {
  return db.transaction().execute(async (tx) => {
    const rows = await tx
      .selectFrom("outbox_events")
      .select(["id", "tenant_id", "location_id", "event_type", "payload"])
      .where("processed_at", "is", null)
      .orderBy("id")
      .limit(batchSize)
      .forUpdate()
      .skipLocked()
      .execute();
    if (rows.length === 0) return 0;
    for (const row of rows) {
      for (const d of routeEvent(row)) {
        emitter.to(d.rooms).emit(row.event_type, { ...d.payload, eventId: row.id });
      }
    }
    await tx
      .updateTable("outbox_events")
      .set((eb) => ({ processed_at: new Date(), attempts: eb("attempts", "+", 1) }))
      .where(
        "id",
        "in",
        rows.map((r) => r.id),
      )
      .execute();
    return rows.length;
  });
}
