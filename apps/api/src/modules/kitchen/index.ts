/**
 * kitchen: kitchen tickets and item-level preparation/serving status (basic workflow only:
 * no stations, inventory, recipes or costing).
 *
 * Tickets come from dine-in orders (table session + table name) and from accepted online orders (no table; shown by
 * order number, with a due time). Online tickets are handed over by the online-orders workflow, never "served" at a table.
 */
import type { Tx } from "../../infrastructure/database/db.js";
import type {
  KitchenItemStatus,
  KitchenTicketStatus,
  OrderSource,
} from "../../infrastructure/database/schema.js";
import { appendOutbox } from "../../infrastructure/events/outbox.js";
import { Errors } from "../../shared/errors/app-error.js";
import type { StaffContext } from "../../shared/types/access-context.js";
import { recordAudit } from "../audit/index.js";
import { getSession, listActiveSessions } from "../tables/index.js";
import {
  type KitchenAction,
  assertTransition,
  deriveTicketStatus,
  isEditable,
  transitionFor,
} from "./domain/status.js";

export { isEditable } from "./domain/status.js";

const ONLINE_SOURCES: readonly OrderSource[] = ["ONLINE_PICKUP", "ONLINE_DELIVERY"];
export function isOnlineSource(source: OrderSource): boolean {
  return ONLINE_SOURCES.includes(source);
}

/**
 * Called inside the kitchen action's transaction after a ticket changed (dependency injected at the composition root,
 * so kitchen never imports the modules that react to it). Used by online-orders to follow preparation progress.
 */
export type KitchenTicketObserver = (
  tx: Tx,
  ctx: StaffContext,
  ticket: KitchenTicketView,
) => Promise<void>;

export interface NewTicketItem {
  orderItemId: string;
  nameJa: string;
  nameEn: string | null;
  quantity: number;
  note: string | null;
}

export interface KitchenItemView {
  id: string;
  orderItemId: string;
  nameJa: string;
  nameEn: string | null;
  quantity: number;
  note: string | null;
  status: KitchenItemStatus;
  version: number;
}

export interface KitchenTicketView {
  id: string;
  orderId: string;
  orderNo: number;
  tableSessionId: string | null;
  tableName: string | null;
  dueAt: Date | null;
  source: OrderSource;
  status: KitchenTicketStatus;
  createdAt: Date;
  items: KitchenItemView[];
}

/**
 * Called by orders inside the order transaction: one ticket per order submission.
 * The kitchen starts as soon as the restaurant receives the order: tickets and items are created directly in
 * `preparing` (there is no separate "new"/"start" step on the kitchen screen). Items are therefore no longer editable
 * by floor staff once sent; voiding them needs `orders.void_prepared` (managers) and a reason.
 */
export async function createTicket(
  tx: Tx,
  args: {
    tenantId: string;
    locationId: string;
    orderId: string;
    orderNo: number;
    tableSessionId: string | null;
    tableName: string | null;
    dueAt?: Date | null;
    source: OrderSource;
    items: NewTicketItem[];
  },
): Promise<string> {
  const ticket = await tx
    .insertInto("kitchen_tickets")
    .values({
      tenant_id: args.tenantId,
      location_id: args.locationId,
      order_id: args.orderId,
      order_no: args.orderNo,
      table_session_id: args.tableSessionId,
      table_name: args.tableName,
      due_at: args.dueAt ?? null,
      source: args.source,
      status: "preparing",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const startedAt = new Date();
  await tx
    .insertInto("kitchen_ticket_items")
    .values(
      args.items.map((i) => ({
        tenant_id: args.tenantId,
        location_id: args.locationId,
        ticket_id: ticket.id,
        order_item_id: i.orderItemId,
        name_ja: i.nameJa,
        name_en: i.nameEn,
        quantity: i.quantity,
        note: i.note,
        status: "preparing" as const,
        started_at: startedAt,
      })),
    )
    .execute();
  await appendOutbox(tx, args.tenantId, args.locationId, {
    type: "kitchen.ticket.created",
    payload: {
      ticketId: ticket.id,
      orderNo: args.orderNo,
      source: args.source,
      tableSessionId: args.tableSessionId,
      tableName: args.tableName,
    },
  });
  return ticket.id;
}

async function loadTickets(
  tx: Tx,
  locationId: string,
  where: { statuses?: KitchenTicketStatus[]; ticketIds?: string[] },
): Promise<KitchenTicketView[]> {
  let q = tx
    .selectFrom("kitchen_tickets")
    .select([
      "id",
      "order_id",
      "order_no",
      "table_session_id",
      "table_name",
      "due_at",
      "source",
      "status",
      "created_at",
    ])
    .where("location_id", "=", locationId);
  if (where.statuses) q = q.where("status", "in", where.statuses);
  if (where.ticketIds) q = q.where("id", "in", where.ticketIds);
  const tickets = await q.orderBy("created_at").orderBy("id").execute();
  if (tickets.length === 0) return [];
  const items = await tx
    .selectFrom("kitchen_ticket_items")
    .select([
      "id",
      "ticket_id",
      "order_item_id",
      "name_ja",
      "name_en",
      "quantity",
      "note",
      "status",
      "version",
    ])
    .where(
      "ticket_id",
      "in",
      tickets.map((t) => t.id),
    )
    .orderBy("id")
    .execute();
  return tickets.map((t) => ({
    id: t.id,
    orderId: t.order_id,
    orderNo: t.order_no,
    tableSessionId: t.table_session_id,
    tableName: t.table_name,
    dueAt: t.due_at,
    source: t.source,
    status: t.status,
    createdAt: t.created_at,
    items: items
      .filter((i) => i.ticket_id === t.id)
      .map((i) => ({
        id: i.id,
        orderItemId: i.order_item_id,
        nameJa: i.name_ja,
        nameEn: i.name_en,
        quantity: i.quantity,
        note: i.note,
        status: i.status,
        version: i.version,
      })),
  }));
}

/** Kitchen display: tickets that still need preparing or pickup. */
export function listOpenTickets(tx: Tx, locationId: string): Promise<KitchenTicketView[]> {
  return loadTickets(tx, locationId, { statuses: ["new", "preparing", "ready"] });
}

/**
 * Applies a kitchen action to items. Target either specific items or all eligible items of a ticket.
 * Invalid transitions are rejected (for explicit item targets) or skipped (for ticket-wide actions).
 */
export async function applyKitchenAction(
  tx: Tx,
  ctx: StaffContext,
  action: KitchenAction,
  target: { itemId: string } | { ticketId: string },
): Promise<KitchenTicketView> {
  const now = new Date();
  let ticketId: string;
  let itemIds: string[];

  if ("itemId" in target) {
    const item = await tx
      .selectFrom("kitchen_ticket_items")
      .select(["id", "ticket_id", "status"])
      .where("id", "=", target.itemId)
      .where("location_id", "=", ctx.locationId)
      .forUpdate()
      .executeTakeFirst();
    if (!item) throw Errors.notFound("kitchen item");
    if (action === "serve") await assertServableAtTable(tx, item.ticket_id);
    assertTransition(item.status, action);
    ticketId = item.ticket_id;
    itemIds = [item.id];
  } else {
    if (action === "serve") await assertServableAtTable(tx, target.ticketId);
    const { from } = transitionFor(action);
    const rows = await tx
      .selectFrom("kitchen_ticket_items")
      .select(["id"])
      .where("ticket_id", "=", target.ticketId)
      .where("location_id", "=", ctx.locationId)
      .where("status", "=", from)
      .orderBy("id")
      .forUpdate()
      .execute();
    if (rows.length === 0) {
      const exists = await tx
        .selectFrom("kitchen_tickets")
        .select("id")
        .where("id", "=", target.ticketId)
        .where("location_id", "=", ctx.locationId)
        .executeTakeFirst();
      if (!exists) throw Errors.notFound("kitchen ticket");
      throw Errors.conflict("invalid_kitchen_transition", `No items on this ticket can ${action}`);
    }
    ticketId = target.ticketId;
    itemIds = rows.map((r) => r.id);
  }

  return commitAction(tx, ctx, action, ticketId, itemIds, now);
}

/**
 * Applies an already-validated transition to locked items of ONE ticket, refreshes the derived ticket status and
 * writes the outbox events and audit entry. Every kitchen/floor action goes through here.
 */
async function commitAction(
  tx: Tx,
  ctx: StaffContext,
  action: KitchenAction,
  ticketId: string,
  itemIds: string[],
  now: Date,
): Promise<KitchenTicketView> {
  const to = transitionFor(action).to;
  await tx
    .updateTable("kitchen_ticket_items")
    .set((eb) => ({
      status: to,
      version: eb("version", "+", 1),
      ...(action === "start" ? { started_at: now } : {}),
      ...(action === "ready" ? { ready_at: now } : {}),
      ...(action === "serve" ? { served_at: now, served_by: ctx.userId } : {}),
    }))
    .where("id", "in", itemIds)
    .execute();

  const ticket = await refreshTicketStatus(tx, ticketId);
  await appendOutbox(tx, ctx.tenantId, ctx.locationId, {
    type: "kitchen.item.status_changed",
    payload: {
      ticketId,
      tableSessionId: ticket.tableSessionId,
      kitchenItemIds: itemIds,
      status: to,
      ticketStatus: ticket.status,
    },
  });

  // Table food: alert the floor. Online tickets are followed by online-orders instead (kitchen hook).
  const { tableSessionId, tableName } = ticket;
  if (action === "ready" && tableSessionId !== null && tableName !== null) {
    const session = await getSession(tx, ctx.locationId, tableSessionId);
    await appendOutbox(tx, ctx.tenantId, ctx.locationId, {
      type: "waiter.food.ready",
      payload: {
        ticketId,
        tableSessionId,
        tableName,
        assignedWaiterId: session.assignedWaiterId,
        items: ticket.items
          .filter((i) => itemIds.includes(i.id))
          .map((i) => ({
            kitchenItemId: i.id,
            nameJa: i.nameJa,
            nameEn: i.nameEn,
            quantity: i.quantity,
            note: i.note,
          })),
      },
    });
  }
  if (action === "serve" && tableSessionId !== null) {
    await appendOutbox(tx, ctx.tenantId, ctx.locationId, {
      type: "waiter.food.served",
      payload: { ticketId, tableSessionId, kitchenItemIds: itemIds },
    });
    await recordAudit(tx, ctx, {
      action: "kitchen.items_served",
      targetType: "kitchen_ticket",
      targetId: ticketId,
      metadata: { itemIds },
    });
  }
  return ticket;
}

/**
 * Floor serving rules for a ticket: online tickets are handed over by the online-orders workflow (pickup/dispatch),
 * and food of a dining session that has been closed (settled) is no longer a service task.
 */
async function assertServableAtTable(tx: Tx, ticketId: string): Promise<void> {
  const t = await tx
    .selectFrom("kitchen_tickets as t")
    .leftJoin("table_sessions as s", "s.id", "t.table_session_id")
    .select(["t.source", "s.status as session_status"])
    .where("t.id", "=", ticketId)
    .executeTakeFirst();
  if (t && isOnlineSource(t.source))
    throw Errors.conflict(
      "online_handover_required",
      "Online orders are handed over from the Online orders screen",
    );
  if (t?.session_status === "closed")
    throw Errors.conflict("session_closed", "This table's dining session is already closed");
}

// ---------------------------------------------------------------- floor (waiter) actions

const MAX_FLOOR_BATCH = 50;

/** Locks the given items of THIS location in id order (the same lock order as every other kitchen action). */
async function lockFloorItems(tx: Tx, ctx: StaffContext, itemIds: readonly string[]) {
  const ids = [...new Set(itemIds)];
  if (ids.length === 0 || ids.length > MAX_FLOOR_BATCH)
    throw Errors.validation({ kitchenItemIds: `1 to ${String(MAX_FLOOR_BATCH)} items` });
  const rows = await tx
    .selectFrom("kitchen_ticket_items")
    .select(["id", "ticket_id", "status", "picked_up_by"])
    .where("id", "in", ids)
    .where("location_id", "=", ctx.locationId)
    .orderBy("id")
    .forUpdate()
    .execute();
  // Unknown ids, or ids of another branch/tenant (RLS + location filter), are indistinguishable: not found.
  if (rows.length !== ids.length) throw Errors.notFound("kitchen item");
  for (const ticketId of new Set(rows.map((r) => r.ticket_id)))
    await assertServableAtTable(tx, ticketId);
  return rows;
}

function byTicket(rows: readonly { id: string; ticket_id: string }[]) {
  const groups = new Map<string, string[]>();
  for (const r of rows) groups.set(r.ticket_id, [...(groups.get(r.ticket_id) ?? []), r.id]);
  return groups;
}

/**
 * Marks specific ready items served, across one or more tickets (e.g. several orders of the same table).
 * All-or-nothing: if any item is not `ready` (already served by someone else, still preparing, voided) the whole
 * request is rejected with 409 and nothing changes, so a waiter never serves food they did not mean to.
 */
export async function serveFloorItems(
  tx: Tx,
  ctx: StaffContext,
  itemIds: readonly string[],
): Promise<KitchenTicketView[]> {
  const rows = await lockFloorItems(tx, ctx, itemIds);
  for (const r of rows) assertTransition(r.status, "serve");
  const now = new Date();
  const tickets: KitchenTicketView[] = [];
  for (const [ticketId, ids] of byTicket(rows))
    tickets.push(await commitAction(tx, ctx, "serve", ticketId, ids, now));
  return tickets;
}

/**
 * Pickup acknowledgement ("I have taken this from the pass"). Only for `ready` items; the item stays `ready` until it
 * is served. Repeating it for items you already picked up is a no-op; items another waiter picked up are rejected
 * (409 already_picked_up), so two waiters never carry the same food.
 */
export async function acknowledgePickup(
  tx: Tx,
  ctx: StaffContext,
  itemIds: readonly string[],
): Promise<{ pickedUp: string[] }> {
  const rows = await lockFloorItems(tx, ctx, itemIds);
  for (const r of rows) {
    if (r.status !== "ready")
      throw Errors.conflict(
        "invalid_kitchen_transition",
        `Cannot pick up an item that is ${r.status}`,
        {
          current: r.status,
          action: "pickup",
        },
      );
    if (r.picked_up_by !== null && r.picked_up_by !== ctx.userId)
      throw Errors.conflict("already_picked_up", "Another staff member has already picked this up");
  }
  const todo = rows.filter((r) => r.picked_up_by === null);
  if (todo.length === 0) return { pickedUp: [] };
  const now = new Date();
  await tx
    .updateTable("kitchen_ticket_items")
    .set((eb) => ({ picked_up_at: now, picked_up_by: ctx.userId, version: eb("version", "+", 1) }))
    .where(
      "id",
      "in",
      todo.map((r) => r.id),
    )
    .execute();
  for (const [ticketId, ids] of byTicket(todo)) {
    const t = await tx
      .selectFrom("kitchen_tickets")
      .select("table_session_id")
      .where("id", "=", ticketId)
      .executeTakeFirstOrThrow();
    if (t.table_session_id === null) continue; // unreachable: online tickets are rejected above
    await appendOutbox(tx, ctx.tenantId, ctx.locationId, {
      type: "waiter.food.picked_up",
      payload: { ticketId, tableSessionId: t.table_session_id, kitchenItemIds: ids },
    });
    await recordAudit(tx, ctx, {
      action: "kitchen.items_picked_up",
      targetType: "kitchen_ticket",
      targetId: ticketId,
      metadata: { itemIds: ids },
    });
  }
  return { pickedUp: todo.map((r) => r.id) };
}

export interface FloorItemView {
  kitchenItemId: string;
  ticketId: string;
  orderNo: number;
  tableSessionId: string;
  tableName: string;
  nameJa: string;
  nameEn: string | null;
  quantity: number;
  note: string | null;
  status: "queued" | "preparing" | "ready";
  orderedAt: Date;
  startedAt: Date | null;
  readyAt: Date | null;
  pickedUp: { at: Date; byUserId: string; byName: string } | null;
}

export interface FloorTableView {
  tableSessionId: string;
  tableId: string;
  tableName: string;
  status: "open" | "bill_requested";
  guestCount: number;
  openedAt: Date;
  assignedWaiterId: string | null;
  readyCount: number;
  preparingCount: number;
  servedCount: number;
}

/**
 * Everything a waiter needs, straight from PostgreSQL: ready food (to pick up and serve), food still in preparation,
 * and the service state of every occupied table. Only dine-in tickets of OPEN (not closed) sessions of this location.
 * Counts are portions (quantities), the way waiters carry plates. No money, no customer data.
 */
export async function getFloorBoard(tx: Tx, locationId: string) {
  const [rows, sessions] = await Promise.all([
    tx
      .selectFrom("kitchen_ticket_items as i")
      .innerJoin("kitchen_tickets as t", "t.id", "i.ticket_id")
      .innerJoin("table_sessions as s", "s.id", "t.table_session_id")
      .leftJoin("users as u", "u.id", "i.picked_up_by")
      .select([
        "i.id",
        "i.ticket_id",
        "t.order_no",
        "t.table_session_id",
        "t.table_name",
        "t.created_at",
        "i.name_ja",
        "i.name_en",
        "i.quantity",
        "i.note",
        "i.status",
        "i.started_at",
        "i.ready_at",
        "i.picked_up_at",
        "i.picked_up_by",
        "u.display_name as picked_up_name",
      ])
      .where("i.location_id", "=", locationId)
      .where("i.status", "in", ["queued", "preparing", "ready"])
      .where("s.status", "<>", "closed")
      .orderBy("i.ready_at")
      .orderBy("t.created_at")
      .orderBy("i.id")
      .execute(),
    listActiveSessions(tx, locationId),
  ]);
  const served =
    sessions.length === 0
      ? []
      : await tx
          .selectFrom("kitchen_ticket_items as i")
          .innerJoin("kitchen_tickets as t", "t.id", "i.ticket_id")
          .select(["t.table_session_id", (eb) => eb.fn.sum<string>("i.quantity").as("n")])
          .where(
            "t.table_session_id",
            "in",
            sessions.map((x) => x.id),
          )
          .where("i.status", "=", "served")
          .groupBy("t.table_session_id")
          .execute();

  const items: FloorItemView[] = rows.flatMap((r) =>
    r.table_session_id === null ||
    r.table_name === null ||
    r.status === "served" ||
    r.status === "voided"
      ? []
      : [
          {
            kitchenItemId: r.id,
            ticketId: r.ticket_id,
            orderNo: r.order_no,
            tableSessionId: r.table_session_id,
            tableName: r.table_name,
            nameJa: r.name_ja,
            nameEn: r.name_en,
            quantity: r.quantity,
            note: r.note,
            status: r.status,
            orderedAt: r.created_at,
            startedAt: r.started_at,
            readyAt: r.ready_at,
            pickedUp:
              r.picked_up_at && r.picked_up_by
                ? { at: r.picked_up_at, byUserId: r.picked_up_by, byName: r.picked_up_name ?? "" }
                : null,
          },
        ],
  );
  const ready = items.filter((i) => i.status === "ready");
  const preparing = items.filter((i) => i.status !== "ready");
  const sum = (list: FloorItemView[], sessionId: string) =>
    list.reduce((n, i) => (i.tableSessionId === sessionId ? n + i.quantity : n), 0);
  const servedBy = new Map(served.map((r) => [r.table_session_id, Number(r.n)]));

  const tables: FloorTableView[] = sessions
    .map((x) => ({
      tableSessionId: x.id,
      tableId: x.tableId,
      tableName: x.tableName,
      status: x.status === "bill_requested" ? ("bill_requested" as const) : ("open" as const),
      guestCount: x.guestCount,
      openedAt: x.openedAt,
      assignedWaiterId: x.assignedWaiterId,
      readyCount: sum(ready, x.id),
      preparingCount: sum(preparing, x.id),
      servedCount: servedBy.get(x.id) ?? 0,
    }))
    .sort((a, b) => a.tableName.localeCompare(b.tableName, "ja", { numeric: true }));

  return {
    serverTime: new Date(),
    counts: {
      ready: ready.reduce((n, i) => n + i.quantity, 0),
      preparing: preparing.reduce((n, i) => n + i.quantity, 0),
      activeTables: tables.length,
    },
    ready,
    preparing,
    tables,
  };
}

/**
 * Locks every item of an order's ticket (if it has one), in id order. Online-orders calls this BEFORE locking its own
 * row, matching the kitchen action's lock order (items, then the online order) so the two never deadlock.
 */
export async function lockOrderTicketItems(tx: Tx, orderId: string): Promise<void> {
  await tx
    .selectFrom("kitchen_ticket_items as i")
    .innerJoin("kitchen_tickets as t", "t.id", "i.ticket_id")
    .select("i.id")
    .where("t.order_id", "=", orderId)
    .orderBy("i.id")
    .forUpdate("i")
    .execute();
}

/** The ticket of an order, or null if it was never sent to the kitchen. */
export async function getTicketForOrder(
  tx: Tx,
  locationId: string,
  orderId: string,
): Promise<KitchenTicketView | null> {
  const t = await tx
    .selectFrom("kitchen_tickets")
    .select("id")
    .where("order_id", "=", orderId)
    .where("location_id", "=", locationId)
    .executeTakeFirst();
  if (!t) return null;
  const [view] = await loadTickets(tx, locationId, { ticketIds: [t.id] });
  return view ?? null;
}

/**
 * Online handover (pickup collected or delivery dispatched): every ready item becomes `served`, which takes the ticket
 * off the kitchen display. Requires the whole ticket to be ready.
 */
export async function handOverOrderTicket(
  tx: Tx,
  ctx: StaffContext,
  orderId: string,
): Promise<void> {
  const ticket = await getTicketForOrder(tx, ctx.locationId, orderId);
  if (!ticket)
    throw Errors.conflict("not_in_kitchen", "This order has not been sent to the kitchen");
  if (ticket.status !== "ready")
    throw Errors.conflict("kitchen_not_ready", "The kitchen has not finished this order");
  const ids = ticket.items.filter((i) => i.status === "ready").map((i) => i.id);
  const now = new Date();
  await tx
    .updateTable("kitchen_ticket_items")
    .set((eb) => ({
      status: "served",
      served_at: now,
      served_by: ctx.userId,
      version: eb("version", "+", 1),
    }))
    .where("id", "in", ids)
    .execute();
  const updated = await refreshTicketStatus(tx, ticket.id);
  await appendOutbox(tx, ctx.tenantId, ctx.locationId, {
    type: "kitchen.item.status_changed",
    payload: {
      ticketId: ticket.id,
      tableSessionId: null,
      kitchenItemIds: ids,
      status: "served",
      ticketStatus: updated.status,
    },
  });
}

/** Voids every not-yet-served item of an order's ticket (order cancellation). No-op if there is no ticket. */
export async function voidOrderTicket(tx: Tx, orderId: string): Promise<void> {
  const t = await tx
    .selectFrom("kitchen_tickets")
    .select(["id", "location_id", "tenant_id", "table_session_id"])
    .where("order_id", "=", orderId)
    .executeTakeFirst();
  if (!t) return;
  const rows = await tx
    .updateTable("kitchen_ticket_items")
    .set((eb) => ({ status: "voided", version: eb("version", "+", 1) }))
    .where("ticket_id", "=", t.id)
    .where("status", "in", ["queued", "preparing", "ready"])
    .returning("id")
    .execute();
  const updated = await refreshTicketStatus(tx, t.id);
  if (rows.length > 0) {
    await appendOutbox(tx, t.tenant_id, t.location_id, {
      type: "kitchen.item.status_changed",
      payload: {
        ticketId: t.id,
        tableSessionId: t.table_session_id,
        kitchenItemIds: rows.map((r) => r.id),
        status: "voided",
        ticketStatus: updated.status,
      },
    });
  }
}

async function refreshTicketStatus(tx: Tx, ticketId: string): Promise<KitchenTicketView> {
  const statuses = await tx
    .selectFrom("kitchen_ticket_items")
    .select("status")
    .where("ticket_id", "=", ticketId)
    .execute();
  const status = deriveTicketStatus(statuses.map((s) => s.status));
  const t = await tx
    .updateTable("kitchen_tickets")
    .set({ status, updated_at: new Date() })
    .where("id", "=", ticketId)
    .returning("location_id")
    .executeTakeFirstOrThrow();
  const [view] = await loadTickets(tx, t.location_id, { ticketIds: [ticketId] });
  if (!view) throw Errors.notFound("kitchen ticket");
  return view;
}

/** Outstanding ready-for-pickup items (used by waiter devices to reconcile after reconnect). */
export async function listReadyItems(tx: Tx, locationId: string) {
  const rows = await tx
    .selectFrom("kitchen_ticket_items as i")
    .innerJoin("kitchen_tickets as t", "t.id", "i.ticket_id")
    .select([
      "i.id",
      "i.ticket_id",
      "i.name_ja",
      "i.name_en",
      "i.quantity",
      "i.note",
      "i.ready_at",
      "i.picked_up_at",
      "i.picked_up_by",
      "t.order_no",
      "t.table_session_id",
      "t.table_name",
    ])
    // Inner join: online orders (no table session) are not served by the floor; closed sessions are settled.
    .innerJoin("table_sessions as s", "s.id", "t.table_session_id")
    .where("s.status", "<>", "closed")
    .where("i.location_id", "=", locationId)
    .where("i.status", "=", "ready")
    .orderBy("i.ready_at")
    .execute();
  return rows.flatMap((r) => {
    if (r.table_session_id === null || r.table_name === null) return [];
    return [
      {
        kitchenItemId: r.id,
        ticketId: r.ticket_id,
        tableSessionId: r.table_session_id,
        tableName: r.table_name,
        nameJa: r.name_ja,
        nameEn: r.name_en,
        quantity: r.quantity,
        note: r.note,
        readyAt: r.ready_at,
        orderNo: r.order_no,
        pickedUpAt: r.picked_up_at,
        pickedUpBy: r.picked_up_by,
      },
    ];
  });
}

/** Item statuses keyed by order item id (for order views and edit rules). */
export async function statusesForOrderItems(
  tx: Tx,
  orderItemIds: readonly string[],
): Promise<Map<string, { kitchenItemId: string; status: KitchenItemStatus }>> {
  if (orderItemIds.length === 0) return new Map();
  const rows = await tx
    .selectFrom("kitchen_ticket_items")
    .select(["id", "order_item_id", "status"])
    .where("order_item_id", "in", [...orderItemIds])
    .execute();
  return new Map(rows.map((r) => [r.order_item_id, { kitchenItemId: r.id, status: r.status }]));
}

/** Locks the kitchen item for an order item (used by orders before edit/void). */
export async function lockItemForOrderItem(
  tx: Tx,
  orderItemId: string,
): Promise<{ id: string; ticketId: string; status: KitchenItemStatus }> {
  const row = await tx
    .selectFrom("kitchen_ticket_items")
    .select(["id", "ticket_id", "status"])
    .where("order_item_id", "=", orderItemId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw Errors.notFound("kitchen item");
  return { id: row.id, ticketId: row.ticket_id, status: row.status };
}

/** Mirrors an order-line edit onto the kitchen display (only allowed while queued). */
export async function syncEditedItem(
  tx: Tx,
  orderItemId: string,
  change: { quantity: number; note: string | null },
): Promise<void> {
  const item = await lockItemForOrderItem(tx, orderItemId);
  if (!isEditable(item.status))
    throw Errors.conflict("item_in_preparation", "The kitchen has already started this item");
  await tx
    .updateTable("kitchen_ticket_items")
    .set((eb) => ({ quantity: change.quantity, note: change.note, version: eb("version", "+", 1) }))
    .where("id", "=", item.id)
    .execute();
}

export async function voidItemForOrderItem(
  tx: Tx,
  orderItemId: string,
): Promise<{ ticketId: string; previous: KitchenItemStatus }> {
  const item = await lockItemForOrderItem(tx, orderItemId);
  await tx
    .updateTable("kitchen_ticket_items")
    .set((eb) => ({ status: "voided", version: eb("version", "+", 1) }))
    .where("id", "=", item.id)
    .execute();
  await refreshTicketStatus(tx, item.ticketId);
  return { ticketId: item.ticketId, previous: item.status };
}

/** Counts of ready-but-unserved items per table session (floor view). */
export async function readyCountsBySession(
  tx: Tx,
  sessionIds: readonly string[],
): Promise<Map<string, number>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await tx
    .selectFrom("kitchen_ticket_items as i")
    .innerJoin("kitchen_tickets as t", "t.id", "i.ticket_id")
    .select(["t.table_session_id", (eb) => eb.fn.countAll<string>().as("n")])
    .where("t.table_session_id", "in", [...sessionIds])
    .where("i.status", "=", "ready")
    .groupBy("t.table_session_id")
    .execute();
  return new Map(
    rows.flatMap((r) =>
      r.table_session_id === null ? [] : [[r.table_session_id, Number(r.n)] as const],
    ),
  );
}
