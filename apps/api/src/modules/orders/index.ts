/**
 * orders: order submissions and lines with server-authoritative price snapshots.
 * ONE implementation for every channel: STAFF_POS and TABLE_QR orders belong to a dining session;
 * ONLINE_PICKUP and ONLINE_DELIVERY orders are standalone (no session, no table) and use the takeout tax channel.
 */
import { z } from "zod";
import type { Tx } from "../../infrastructure/database/db.js";
import { nextCounter } from "../../infrastructure/database/db.js";
import type { KitchenItemStatus, OrderSource } from "../../infrastructure/database/schema.js";
import { appendOutbox } from "../../infrastructure/events/outbox.js";
import { Errors } from "../../shared/errors/app-error.js";
import type { GuestContext, StaffContext } from "../../shared/types/access-context.js";
import { recordAudit } from "../audit/index.js";
import { can } from "../authorization/index.js";
import {
  createTicket,
  isEditable,
  lockItemForOrderItem,
  statusesForOrderItems,
  syncEditedItem,
  voidItemForOrderItem,
  voidOrderTicket,
} from "../kitchen/index.js";
import { type TaxChannel, getOrderableItems } from "../menus/index.js";
import { getLocationSettings } from "../restaurants/index.js";
import { assertAcceptsOrders, lockSession } from "../tables/index.js";
import { MAX_NOTE_LENGTH, normalizeNote } from "./domain/notes.js";
import { type BillTotals, computeBill } from "./domain/pricing.js";

export { normalizeNote, MAX_NOTE_LENGTH } from "./domain/notes.js";
export { computeBill, type BillTotals, type PricedLine } from "./domain/pricing.js";

export const MAX_LINES_PER_ORDER = 50;

/** Order submission contract (shared by STAFF_POS and TABLE_QR). Prices are never accepted from clients. */
export const OrderItemsBody = z.strictObject({
  items: z
    .array(
      z.strictObject({
        menuItemId: z.uuid(),
        quantity: z.int().min(1).max(99),
        note: z.string().max(MAX_NOTE_LENGTH).nullish(),
      }),
    )
    .min(1)
    .max(MAX_LINES_PER_ORDER),
});

export interface OrderLineInput {
  menuItemId: string;
  quantity: number;
  note?: string | null | undefined;
}

export interface OrderItemView {
  id: string;
  menuItemId: string;
  nameJa: string;
  nameEn: string | null;
  unitPriceYen: number;
  quantity: number;
  lineTotalYen: number;
  taxRateBp: number;
  note: string | null;
  status: "active" | "voided";
  kitchenItemId: string | null;
  kitchenStatus: KitchenItemStatus | null;
  version: number;
}

export interface OrderView {
  id: string;
  orderNo: number;
  source: OrderSource;
  createdAt: Date;
  items: OrderItemView[];
}

export type OnlineOrderSource = "ONLINE_PICKUP" | "ONLINE_DELIVERY";

const ITEM_COLUMNS = [
  "id",
  "menu_item_id",
  "name_ja",
  "name_en",
  "unit_price_yen",
  "quantity",
  "line_total_yen",
  "tax_rate_bp",
  "note",
  "status",
  "version",
] as const;

/** Inserts an order and its lines at CURRENT server prices (and the channel's tax rate). Shared by every channel. */
async function insertOrder(
  tx: Tx,
  args: {
    tenantId: string;
    locationId: string;
    tableSessionId: string | null;
    source: OrderSource;
    createdByUserId: string | null;
    guestSessionId: string | null;
    lines: readonly OrderLineInput[];
    channel: TaxChannel;
  },
) {
  if (args.lines.length === 0 || args.lines.length > MAX_LINES_PER_ORDER) {
    throw Errors.validation({ items: `1-${String(MAX_LINES_PER_ORDER)} lines required` });
  }
  const menu = await getOrderableItems(
    tx,
    args.locationId,
    args.lines.map((l) => l.menuItemId),
    args.channel,
  );
  const orderNo = await nextCounter(tx, args.tenantId, args.locationId, "order");
  const order = await tx
    .insertInto("orders")
    .values({
      tenant_id: args.tenantId,
      location_id: args.locationId,
      table_session_id: args.tableSessionId,
      order_no: orderNo,
      source: args.source,
      created_by_user_id: args.createdByUserId,
      guest_session_id: args.guestSessionId,
    })
    .returning(["id", "created_at"])
    .executeTakeFirstOrThrow();

  // Each submitted line is stored as-is: identical dishes with different notes remain separate lines.
  const items = await tx
    .insertInto("order_items")
    .values(
      args.lines.map((l) => {
        const m = menu.get(l.menuItemId);
        if (!m) throw Errors.unprocessable("item_not_found");
        return {
          tenant_id: args.tenantId,
          location_id: args.locationId,
          order_id: order.id,
          table_session_id: args.tableSessionId,
          menu_item_id: m.id,
          name_ja: m.nameJa,
          name_en: m.nameEn,
          unit_price_yen: m.priceYen,
          quantity: l.quantity,
          tax_rate_bp: m.taxRateBp,
          note: normalizeNote(l.note),
        };
      }),
    )
    .returning([...ITEM_COLUMNS])
    .execute();
  return { orderId: order.id, createdAt: order.created_at, orderNo, items };
}

/**
 * Places an order on a dining session. Locks the session row (serializes with checkout), validates
 * items against the current menu, snapshots prices/tax, creates the kitchen ticket and outbox events
 * in the same transaction.
 */
export async function placeOrder(
  tx: Tx,
  actor: StaffContext | GuestContext,
  tableSessionId: string,
  lines: readonly OrderLineInput[],
): Promise<OrderView> {
  const session = await lockSession(tx, actor.locationId, tableSessionId);
  assertAcceptsOrders(session.status);
  const source: OrderSource = actor.kind === "staff" ? "STAFF_POS" : "TABLE_QR";
  const { orderId, createdAt, orderNo, items } = await insertOrder(tx, {
    tenantId: actor.tenantId,
    locationId: actor.locationId,
    tableSessionId,
    source,
    createdByUserId: actor.kind === "staff" ? actor.userId : null,
    guestSessionId: actor.kind === "guest" ? actor.guestSessionId : null,
    lines,
    channel: "dine_in",
  });

  // Kitchen ticket items preserve insertion order (one per line).
  const ticketId = await createTicket(tx, {
    tenantId: actor.tenantId,
    locationId: actor.locationId,
    orderId: orderId,
    orderNo,
    tableSessionId,
    tableName: session.tableName,
    source,
    items: items.map((i) => ({
      orderItemId: i.id,
      nameJa: i.name_ja,
      nameEn: i.name_en,
      quantity: i.quantity,
      note: i.note,
    })),
  });

  await appendOutbox(tx, actor.tenantId, actor.locationId, {
    type: "order.created",
    payload: {
      orderId: orderId,
      orderNo,
      tableSessionId,
      tableName: session.tableName,
      source,
      itemCount: items.length,
    },
  });
  await recordAudit(tx, actor, {
    action: "order.created",
    targetType: "order",
    targetId: orderId,
    metadata: { source, lines: items.length, ticketId },
  });

  const statuses = await statusesForOrderItems(
    tx,
    items.map((i) => i.id),
  );
  return {
    id: orderId,
    orderNo,
    source,
    createdAt: createdAt,
    items: items.map((i) => toItemView(i, statuses.get(i.id))),
  };
}

function toItemView(
  i: {
    id: string;
    menu_item_id: string;
    name_ja: string;
    name_en: string | null;
    unit_price_yen: number;
    quantity: number;
    line_total_yen: number;
    tax_rate_bp: number;
    note: string | null;
    status: "active" | "voided";
    version: number;
  },
  kitchen: { kitchenItemId: string; status: KitchenItemStatus } | undefined,
): OrderItemView {
  return {
    id: i.id,
    menuItemId: i.menu_item_id,
    nameJa: i.name_ja,
    nameEn: i.name_en,
    unitPriceYen: i.unit_price_yen,
    quantity: i.quantity,
    lineTotalYen: i.line_total_yen,
    taxRateBp: i.tax_rate_bp,
    note: i.note,
    status: i.status,
    kitchenItemId: kitchen?.kitchenItemId ?? null,
    kitchenStatus: kitchen?.status ?? null,
    version: i.version,
  };
}

/** All submissions of a session, oldest first, each with its lines and kitchen status. */
export async function listSessionOrders(tx: Tx, tableSessionId: string): Promise<OrderView[]> {
  const orders = await tx
    .selectFrom("orders")
    .select(["id", "order_no", "source", "created_at"])
    .where("table_session_id", "=", tableSessionId)
    .orderBy("created_at")
    .orderBy("order_no")
    .execute();
  if (orders.length === 0) return [];
  const items = await tx
    .selectFrom("order_items")
    .select([
      "id",
      "order_id",
      "menu_item_id",
      "name_ja",
      "name_en",
      "unit_price_yen",
      "quantity",
      "line_total_yen",
      "tax_rate_bp",
      "note",
      "status",
      "version",
      "created_at",
    ])
    .where("table_session_id", "=", tableSessionId)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  const statuses = await statusesForOrderItems(
    tx,
    items.map((i) => i.id),
  );
  return orders.map((o) => ({
    id: o.id,
    orderNo: o.order_no,
    source: o.source,
    createdAt: o.created_at,
    items: items.filter((i) => i.order_id === o.id).map((i) => toItemView(i, statuses.get(i.id))),
  }));
}

export interface BillLineView {
  orderItemId: string;
  orderNo: number;
  nameJa: string;
  nameEn: string | null;
  note: string | null;
  unitPriceYen: number;
  quantity: number;
  lineTotalYen: number;
  taxRateBp: number;
}

export interface BillView extends BillTotals {
  tableSessionId: string;
  lines: BillLineView[];
}

/** Combined bill for a session: every non-voided line across all submissions. */
export async function getBill(
  tx: Tx,
  locationId: string,
  tableSessionId: string,
): Promise<BillView> {
  const settings = await getLocationSettings(tx, locationId);
  const rows = await tx
    .selectFrom("order_items as i")
    .innerJoin("orders as o", "o.id", "i.order_id")
    .select([
      "i.id",
      "o.order_no",
      "i.name_ja",
      "i.name_en",
      "i.note",
      "i.unit_price_yen",
      "i.quantity",
      "i.line_total_yen",
      "i.tax_rate_bp",
    ])
    .where("i.table_session_id", "=", tableSessionId)
    .where("i.status", "=", "active")
    .orderBy("o.order_no")
    .orderBy("i.created_at")
    .orderBy("i.id")
    .execute();
  const lines: BillLineView[] = rows.map((r) => ({
    orderItemId: r.id,
    orderNo: r.order_no,
    nameJa: r.name_ja,
    nameEn: r.name_en,
    note: r.note,
    unitPriceYen: r.unit_price_yen,
    quantity: r.quantity,
    lineTotalYen: r.line_total_yen,
    taxRateBp: r.tax_rate_bp,
  }));
  const totals = computeBill(lines, {
    pricesIncludeTax: settings.pricesIncludeTax,
    rounding: settings.taxRounding,
  });
  return { tableSessionId, lines, ...totals };
}

/** Running totals for many sessions at once (floor overview). Gross line sums; not a bill. */
export async function sessionTotals(
  tx: Tx,
  sessionIds: readonly string[],
): Promise<Map<string, { subtotalYen: number; itemCount: number }>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await tx
    .selectFrom("order_items")
    .select([
      "table_session_id",
      (eb) => eb.fn.sum<string>("line_total_yen").as("subtotal"),
      (eb) => eb.fn.sum<string>("quantity").as("qty"),
    ])
    .where("table_session_id", "in", [...sessionIds])
    .where("status", "=", "active")
    .groupBy("table_session_id")
    .execute();
  return new Map(
    rows.flatMap((r) =>
      r.table_session_id === null
        ? []
        : [
            [
              r.table_session_id,
              { subtotalYen: Number(r.subtotal), itemCount: Number(r.qty) },
            ] as const,
          ],
    ),
  );
}

/** Online order lines are changed only through the online-order workflow (cancel), never line by line at a table. */
const notATableOrder = () =>
  Errors.conflict(
    "not_a_table_order",
    "Online order items are managed from the Online orders screen",
  );

async function lockOrderItem(tx: Tx, locationId: string, orderItemId: string) {
  const item = await tx
    .selectFrom("order_items")
    .select(["id", "order_id", "table_session_id", "quantity", "note", "status", "version"])
    .where("id", "=", orderItemId)
    .where("location_id", "=", locationId)
    .forUpdate()
    .executeTakeFirst();
  if (!item) throw Errors.notFound("order item");
  return item;
}

/** Edit quantity/note of a line. Allowed only while the kitchen has not started it and the session is not closed. */
export async function editOrderItem(
  tx: Tx,
  ctx: StaffContext,
  orderItemId: string,
  change: { version: number; quantity?: number | undefined; note?: string | null | undefined },
): Promise<void> {
  const probe = await tx
    .selectFrom("order_items")
    .select("table_session_id")
    .where("id", "=", orderItemId)
    .where("location_id", "=", ctx.locationId)
    .executeTakeFirst();
  if (!probe) throw Errors.notFound("order item");
  if (probe.table_session_id === null) throw notATableOrder();
  const session = await lockSession(tx, ctx.locationId, probe.table_session_id);
  if (session.status === "closed")
    throw Errors.conflict("session_closed", "This table session is closed");

  const item = await lockOrderItem(tx, ctx.locationId, orderItemId);
  if (item.status !== "active") throw Errors.conflict("item_voided", "This item was voided");
  if (item.version !== change.version)
    throw Errors.conflict("version_conflict", "This item was changed by someone else");
  const quantity = change.quantity ?? item.quantity;
  const note = change.note === undefined ? item.note : normalizeNote(change.note);

  await syncEditedItem(tx, orderItemId, { quantity, note }); // throws if kitchen already started
  await tx
    .updateTable("order_items")
    .set((eb) => ({ quantity, note, version: eb("version", "+", 1) }))
    .where("id", "=", orderItemId)
    .execute();
  await appendOutbox(tx, ctx.tenantId, ctx.locationId, {
    type: "order.updated",
    payload: {
      orderId: item.order_id,
      tableSessionId: session.id,
      orderItemId,
      change: "edited",
    },
  });
  await recordAudit(tx, ctx, {
    action: "order_item.edited",
    targetType: "order_item",
    targetId: orderItemId,
    metadata: { from: { quantity: item.quantity, note: item.note }, to: { quantity, note } },
  });
}

/**
 * Void a line (removes it from the bill). Before preparation: `orders.edit`.
 * After the kitchen started it: `orders.void_prepared` (managers) and a reason are required.
 */
export async function voidOrderItem(
  tx: Tx,
  ctx: StaffContext,
  orderItemId: string,
  reason: string | null,
): Promise<void> {
  const probe = await tx
    .selectFrom("order_items")
    .select("table_session_id")
    .where("id", "=", orderItemId)
    .where("location_id", "=", ctx.locationId)
    .executeTakeFirst();
  if (!probe) throw Errors.notFound("order item");
  if (probe.table_session_id === null) throw notATableOrder();
  const session = await lockSession(tx, ctx.locationId, probe.table_session_id);
  if (session.status === "closed")
    throw Errors.conflict("session_closed", "This table session is closed");

  const item = await lockOrderItem(tx, ctx.locationId, orderItemId);
  if (item.status !== "active")
    throw Errors.conflict("item_voided", "This item was already voided");
  const kitchen = await lockItemForOrderItem(tx, orderItemId);
  if (!isEditable(kitchen.status)) {
    if (!can(ctx, "orders.void_prepared")) throw Errors.forbidden("orders.void_prepared");
    if (!reason)
      throw Errors.validation({
        reason: "A reason is required to void an item already in preparation",
      });
  }
  await voidItemForOrderItem(tx, orderItemId);
  await tx
    .updateTable("order_items")
    .set((eb) => ({
      status: "voided",
      voided_at: new Date(),
      voided_by: ctx.userId,
      void_reason: reason,
      version: eb("version", "+", 1),
    }))
    .where("id", "=", orderItemId)
    .execute();
  await appendOutbox(tx, ctx.tenantId, ctx.locationId, {
    type: "order.updated",
    payload: {
      orderId: item.order_id,
      tableSessionId: session.id,
      orderItemId,
      change: "voided",
    },
  });
  await recordAudit(tx, ctx, {
    action: "order_item.voided",
    targetType: "order_item",
    targetId: orderItemId,
    metadata: { reason, kitchenStatus: kitchen.status },
  });
}

// ---------------------------------------------------------------- online (standalone) orders

export interface OnlineOrderRecord {
  orderId: string;
  orderNo: number;
  createdAt: Date;
  items: OrderItemView[];
}

/**
 * Creates a standalone online order (no dining session, no table) with takeout-channel tax snapshots.
 * It is NOT sent to the kitchen yet: that happens when the restaurant accepts it (`sendOrderToKitchen`).
 */
export async function createOnlineOrder(
  tx: Tx,
  scope: { tenantId: string; locationId: string },
  source: OnlineOrderSource,
  lines: readonly OrderLineInput[],
): Promise<OnlineOrderRecord> {
  const { orderId, orderNo, createdAt, items } = await insertOrder(tx, {
    tenantId: scope.tenantId,
    locationId: scope.locationId,
    tableSessionId: null,
    source,
    createdByUserId: null,
    guestSessionId: null,
    lines,
    channel: "takeout",
  });
  return { orderId, orderNo, createdAt, items: items.map((i) => toItemView(i, undefined)) };
}

/** Lines of one order with their kitchen status (online order detail, tracking page). */
export async function getOrderItems(tx: Tx, orderId: string): Promise<OrderItemView[]> {
  const items = await tx
    .selectFrom("order_items")
    .select([...ITEM_COLUMNS])
    .where("order_id", "=", orderId)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  const statuses = await statusesForOrderItems(
    tx,
    items.map((i) => i.id),
  );
  return items.map((i) => toItemView(i, statuses.get(i.id)));
}

/** Sends an accepted online order to the existing kitchen workflow (one ticket, one item per line). */
export async function sendOrderToKitchen(
  tx: Tx,
  ctx: StaffContext,
  orderId: string,
  opts: { dueAt: Date | null },
): Promise<string> {
  const order = await tx
    .selectFrom("orders")
    .select(["id", "order_no", "source", "table_session_id"])
    .where("id", "=", orderId)
    .where("location_id", "=", ctx.locationId)
    .executeTakeFirst();
  if (!order) throw Errors.notFound("order");
  if (order.table_session_id !== null) throw Errors.conflict("not_an_online_order");
  const items = (await getOrderItems(tx, orderId)).filter((i) => i.status === "active");
  if (items.length === 0) throw Errors.unprocessable("nothing_to_prepare");
  return createTicket(tx, {
    tenantId: ctx.tenantId,
    locationId: ctx.locationId,
    orderId,
    orderNo: order.order_no,
    tableSessionId: null,
    tableName: null,
    dueAt: opts.dueAt,
    source: order.source,
    items: items.map((i) => ({
      orderItemId: i.id,
      nameJa: i.nameJa,
      nameEn: i.nameEn,
      quantity: i.quantity,
      note: i.note,
    })),
  });
}

/** Voids every active line of an order and its kitchen ticket (whole-order cancellation or rejection). */
export async function voidOrder(
  tx: Tx,
  args: { locationId: string; orderId: string; voidedBy: string | null; reason: string },
): Promise<void> {
  await tx
    .updateTable("order_items")
    .set((eb) => ({
      status: "voided",
      voided_at: new Date(),
      voided_by: args.voidedBy,
      void_reason: Array.from(args.reason).slice(0, 200).join(""),
      version: eb("version", "+", 1),
    }))
    .where("order_id", "=", args.orderId)
    .where("location_id", "=", args.locationId)
    .where("status", "=", "active")
    .execute();
  await voidOrderTicket(tx, args.orderId);
}

/** Active lines of many orders at once, keyed by order id (online order lists). */
export async function getItemsForOrders(
  tx: Tx,
  orderIds: readonly string[],
): Promise<
  Map<string, { nameJa: string; nameEn: string | null; quantity: number; note: string | null }[]>
> {
  if (orderIds.length === 0) return new Map();
  const rows = await tx
    .selectFrom("order_items")
    .select(["order_id", "name_ja", "name_en", "quantity", "note"])
    .where("order_id", "in", [...orderIds])
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  const map = new Map<
    string,
    { nameJa: string; nameEn: string | null; quantity: number; note: string | null }[]
  >();
  for (const r of rows) {
    const list = map.get(r.order_id) ?? [];
    list.push({ nameJa: r.name_ja, nameEn: r.name_en, quantity: r.quantity, note: r.note });
    map.set(r.order_id, list);
  }
  return map;
}
