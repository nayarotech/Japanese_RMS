/**
 * kitchen: kitchen tickets and item-level preparation/serving status (basic workflow only:
 * no stations, inventory, recipes or costing).
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
import { getSession } from "../tables/index.js";
import {
  type KitchenAction,
  assertTransition,
  deriveTicketStatus,
  isEditable,
  transitionFor,
} from "./domain/status.js";

export { isEditable } from "./domain/status.js";

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
  tableSessionId: string;
  tableName: string;
  source: OrderSource;
  status: KitchenTicketStatus;
  createdAt: Date;
  items: KitchenItemView[];
}

/** Called by orders inside the order transaction: one ticket per order submission. */
export async function createTicket(
  tx: Tx,
  args: {
    tenantId: string;
    locationId: string;
    orderId: string;
    tableSessionId: string;
    tableName: string;
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
      table_session_id: args.tableSessionId,
      table_name: args.tableName,
      source: args.source,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
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
      })),
    )
    .execute();
  await appendOutbox(tx, args.tenantId, args.locationId, {
    type: "kitchen.ticket.created",
    payload: {
      ticketId: ticket.id,
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
    .select(["id", "order_id", "table_session_id", "table_name", "source", "status", "created_at"])
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
    tableSessionId: t.table_session_id,
    tableName: t.table_name,
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
    assertTransition(item.status, action);
    ticketId = item.ticket_id;
    itemIds = [item.id];
  } else {
    const { from } = transitionFor(action);
    const rows = await tx
      .selectFrom("kitchen_ticket_items")
      .select(["id"])
      .where("ticket_id", "=", target.ticketId)
      .where("location_id", "=", ctx.locationId)
      .where("status", "=", from)
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

  if (action === "ready") {
    const session = await getSession(tx, ctx.locationId, ticket.tableSessionId);
    await appendOutbox(tx, ctx.tenantId, ctx.locationId, {
      type: "waiter.food.ready",
      payload: {
        ticketId,
        tableSessionId: ticket.tableSessionId,
        tableName: ticket.tableName,
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
  if (action === "serve") {
    await appendOutbox(tx, ctx.tenantId, ctx.locationId, {
      type: "waiter.food.served",
      payload: { ticketId, tableSessionId: ticket.tableSessionId, kitchenItemIds: itemIds },
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
      "t.table_session_id",
      "t.table_name",
    ])
    .where("i.location_id", "=", locationId)
    .where("i.status", "=", "ready")
    .orderBy("i.ready_at")
    .execute();
  return rows.map((r) => ({
    kitchenItemId: r.id,
    ticketId: r.ticket_id,
    tableSessionId: r.table_session_id,
    tableName: r.table_name,
    nameJa: r.name_ja,
    nameEn: r.name_en,
    quantity: r.quantity,
    note: r.note,
    readyAt: r.ready_at,
  }));
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
  return new Map(rows.map((r) => [r.table_session_id, Number(r.n)]));
}
