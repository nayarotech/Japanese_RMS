/**
 * Restaurant-side online order management: incoming queue, acceptance/rejection, kitchen hand-off, pickup handover,
 * delivery dispatch/delivery, cash collection and cancellation. Permission and entitlement checks happen in the HTTP
 * layer before these run; every state change goes through `transition()` (validated, locked, audited).
 */
import type { Tx } from "../../../infrastructure/database/db.js";
import { Errors } from "../../../shared/errors/app-error.js";
import type { StaffContext } from "../../../shared/types/access-context.js";
import { recordAudit } from "../../audit/index.js";
import { can } from "../../authorization/index.js";
import { type KitchenTicketView, handOverOrderTicket } from "../../kitchen/index.js";
import {
  getItemsForOrders,
  getOrderItems,
  sendOrderToKitchen,
  voidOrder,
} from "../../orders/index.js";
import { getOrderPayment, recordOrderCashPayment } from "../../payments/index.js";
import {
  TERMINAL_STATUSES,
  actionForKitchenStatus,
  assertCanRecordPayment,
  cancellationNeedsManager,
  paymentStatusAfterCancellation,
} from "../domain/status.js";
import {
  type OnlineOrderRow,
  emitOnlineEvent,
  getOnlineOrder,
  lockOnlineOrder,
  lockOnlineOrderByOrderId,
  toRow,
  transition,
} from "./records.js";

export const REJECTION_REASONS = [
  "store_busy",
  "item_unavailable",
  "outside_hours",
  "cannot_deliver",
  "other",
] as const;
export const CANCELLATION_REASONS = [
  "customer_request",
  "no_show",
  "cannot_fulfill",
  "delivery_failed",
  "other",
] as const;

const staffActor = (ctx: StaffContext) => ({ type: "staff" as const, id: ctx.userId });

function summary(row: OnlineOrderRow, items: Awaited<ReturnType<typeof getItemsForOrders>>) {
  return {
    id: row.id,
    orderNo: row.orderNo,
    fulfillmentType: row.fulfillmentType,
    status: row.status,
    paymentMethod: row.paymentMethod,
    paymentStatus: row.paymentStatus,
    scheduledFor: row.scheduledFor,
    createdAt: row.createdAt,
    totalYen: row.totalYen,
    deliveryDistanceM: row.deliveryDistanceM,
    version: row.version,
    items: items.get(row.orderId) ?? [],
  };
}

/**
 * Active = still needs work, plus closed orders with money outstanding (delivered but cash not yet recorded, or a
 * paid order that was cancelled and needs a refund). Recent = the last 50 closed orders.
 */
export async function listOnlineOrders(tx: Tx, locationId: string, scope: "active" | "recent") {
  let q = tx.selectFrom("online_orders").selectAll().where("location_id", "=", locationId);
  q =
    scope === "active"
      ? q
          .where((eb) =>
            eb.or([
              eb("status", "not in", [...TERMINAL_STATUSES]),
              eb.and([eb("status", "=", "delivered"), eb("payment_status", "=", "unpaid")]),
              eb("payment_status", "=", "refund_required"),
            ]),
          )
          .orderBy("created_at", "asc")
      : q
          .where("status", "in", [...TERMINAL_STATUSES])
          .orderBy("created_at", "desc")
          .limit(50);
  const rows = (await q.orderBy("id").execute()).map(toRow);
  const items = await getItemsForOrders(
    tx,
    rows.map((r) => r.orderId),
  );
  return rows.map((r) => summary(r, items));
}

export async function getOnlineOrderDetail(tx: Tx, ctx: StaffContext, id: string) {
  const row = await getOnlineOrder(tx, ctx.locationId, id);
  const [items, history, payment] = await Promise.all([
    getOrderItems(tx, row.orderId),
    tx
      .selectFrom("online_order_status_history")
      .select(["from_status", "to_status", "actor_type", "reason", "created_at"])
      .where("online_order_id", "=", row.id)
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
    getOrderPayment(tx, ctx.locationId, row.orderId),
  ]);
  return {
    ...row,
    items: items.map((i) => ({
      id: i.id,
      nameJa: i.nameJa,
      nameEn: i.nameEn,
      quantity: i.quantity,
      note: i.note,
      unitPriceYen: i.unitPriceYen,
      lineTotalYen: i.lineTotalYen,
      taxRateBp: i.taxRateBp,
      status: i.status,
      kitchenStatus: i.kitchenStatus,
    })),
    history: history.map((h) => ({
      from: h.from_status,
      to: h.to_status,
      actorType: h.actor_type,
      reason: h.reason,
      at: h.created_at,
    })),
    payment,
    canViewContact: can(ctx, "online_orders.contact_view"),
  };
}

/** Customer personal data: separate endpoint, separate permission, every access audited. */
export async function getOnlineOrderContact(tx: Tx, ctx: StaffContext, id: string) {
  const row = await getOnlineOrder(tx, ctx.locationId, id);
  const c = await tx
    .selectFrom("online_order_contacts")
    .selectAll()
    .where("online_order_id", "=", row.id)
    .executeTakeFirst();
  if (!c) throw Errors.notFound("contact");
  await recordAudit(tx, ctx, {
    action: "online_order.contact_viewed",
    targetType: "online_order",
    targetId: row.id,
  });
  return {
    name: c.name,
    phone: c.phone,
    email: c.email,
    address:
      row.fulfillmentType === "delivery"
        ? {
            postalCode: c.postal_code,
            prefecture: c.prefecture,
            city: c.city,
            line1: c.address_line1,
            line2: c.address_line2,
            instructions: c.delivery_instructions,
          }
        : null,
  };
}

// ---------------------------------------------------------------- acceptance

export async function acceptOnlineOrder(tx: Tx, ctx: StaffContext, id: string) {
  const row = await lockOnlineOrder(tx, ctx.locationId, id);
  const next = await transition(tx, row, "accept", staffActor(ctx));
  // Accepted orders enter the EXISTING kitchen workflow (one ticket; due at the pickup/estimated delivery time).
  const ticketId = await sendOrderToKitchen(tx, ctx, row.orderId, { dueAt: row.scheduledFor });
  await recordAudit(tx, ctx, {
    action: "online_order.accepted",
    targetType: "online_order",
    targetId: row.id,
    metadata: { ticketId },
  });
  return next;
}

function reasonText(code: string, note: string | null | undefined): string {
  if (code === "other" && !note?.trim())
    throw Errors.validation({ note: "A note is required for 'other'" });
  return note?.trim() ? `${code}: ${note.trim()}` : code;
}

export async function rejectOnlineOrder(
  tx: Tx,
  ctx: StaffContext,
  id: string,
  input: { reason: (typeof REJECTION_REASONS)[number]; note?: string | null | undefined },
) {
  const row = await lockOnlineOrder(tx, ctx.locationId, id);
  const reason = reasonText(input.reason, input.note);
  const next = await transition(tx, row, "reject", staffActor(ctx), {
    reason,
    rejectionReason: input.reason,
    // Future online payments: a paid order is flagged for refund, never silently dropped.
    paymentStatus: paymentStatusAfterCancellation(row.paymentStatus),
  });
  await voidOrder(tx, {
    locationId: ctx.locationId,
    orderId: row.orderId,
    voidedBy: ctx.userId,
    reason,
  });
  await recordAudit(tx, ctx, {
    action: "online_order.rejected",
    targetType: "online_order",
    targetId: row.id,
    metadata: { reason: input.reason, note: input.note ?? null, paymentStatus: next.paymentStatus },
  });
  return next;
}

export async function cancelOnlineOrder(
  tx: Tx,
  ctx: StaffContext,
  id: string,
  input: { reason: (typeof CANCELLATION_REASONS)[number]; note?: string | null | undefined },
) {
  const row = await lockOnlineOrder(tx, ctx.locationId, id);
  if (row.status === "pending_acceptance")
    throw Errors.conflict("use_reject", "Reject a pending order instead of cancelling it");
  if (cancellationNeedsManager(row.status) && !can(ctx, "online_orders.cancel"))
    throw Errors.forbidden("online_orders.cancel");
  const reason = reasonText(input.reason, input.note);
  const next = await transition(tx, row, "cancel_by_staff", staffActor(ctx), {
    reason,
    cancellationReason: input.reason,
    cancelledBy: "staff",
    paymentStatus: paymentStatusAfterCancellation(row.paymentStatus),
  });
  await voidOrder(tx, {
    locationId: ctx.locationId,
    orderId: row.orderId,
    voidedBy: ctx.userId,
    reason,
  });
  await recordAudit(tx, ctx, {
    action: "online_order.cancelled",
    targetType: "online_order",
    targetId: row.id,
    metadata: {
      reason: input.reason,
      note: input.note ?? null,
      fromStatus: row.status,
      paymentStatus: next.paymentStatus, // refund_required when cash had already been taken
    },
  });
  return next;
}

// ---------------------------------------------------------------- fulfilment

export async function dispatchOnlineOrder(tx: Tx, ctx: StaffContext, id: string) {
  const row = await lockOnlineOrder(tx, ctx.locationId, id);
  const next = await transition(tx, row, "dispatch", staffActor(ctx));
  await handOverOrderTicket(tx, ctx, row.orderId);
  await recordAudit(tx, ctx, {
    action: "online_order.dispatched",
    targetType: "online_order",
    targetId: row.id,
  });
  return next;
}

/** Delivered is a FULFILMENT fact only. Payment stays as recorded (never auto-marked paid on delivery). */
export async function deliverOnlineOrder(tx: Tx, ctx: StaffContext, id: string) {
  const row = await lockOnlineOrder(tx, ctx.locationId, id);
  const next = await transition(tx, row, "deliver", staffActor(ctx));
  await recordAudit(tx, ctx, {
    action: "online_order.delivered",
    targetType: "online_order",
    targetId: row.id,
    metadata: { paymentStatus: next.paymentStatus },
  });
  return next;
}

async function collectCash(
  tx: Tx,
  ctx: StaffContext,
  row: OnlineOrderRow,
  amountReceivedYen: number,
): Promise<OnlineOrderRow> {
  assertCanRecordPayment(row.status, row.paymentStatus);
  await recordOrderCashPayment(tx, ctx, {
    orderId: row.orderId,
    amountDueYen: row.totalYen,
    amountReceivedYen,
  });
  const updated = await tx
    .updateTable("online_orders")
    .set((eb) => ({
      payment_status: "paid",
      version: eb("version", "+", 1),
      updated_at: new Date(),
    }))
    .where("id", "=", row.id)
    .where("version", "=", row.version)
    .returningAll()
    .executeTakeFirst();
  if (!updated)
    throw Errors.conflict("concurrent_update", "This order was changed by someone else");
  const next = toRow(updated);
  await emitOnlineEvent(tx, next, "online.order.payment_recorded");
  return next;
}

/**
 * Records cash actually collected (pay on pickup / cash on delivery). `expectedTotalYen` is what the staff member saw;
 * a mismatch means the screen is stale and nothing is recorded.
 */
export async function recordOnlinePayment(
  tx: Tx,
  ctx: StaffContext,
  id: string,
  input: { amountReceivedYen: number; expectedTotalYen: number },
) {
  const row = await lockOnlineOrder(tx, ctx.locationId, id);
  if (row.totalYen !== input.expectedTotalYen)
    throw Errors.conflict("bill_changed", "The amount due changed", { totalYen: row.totalYen });
  const next = await collectCash(tx, ctx, row, input.amountReceivedYen);
  const payment = await getOrderPayment(tx, ctx.locationId, row.orderId);
  return { order: next, payment };
}

/**
 * Pickup handover: the customer collects the food. If cash has not been recorded yet it must be collected in the
 * same step (amountReceivedYen), so food never leaves unpaid by mistake; the DB also enforces completed => paid.
 */
export async function completePickup(
  tx: Tx,
  ctx: StaffContext,
  id: string,
  input: { amountReceivedYen?: number | undefined; expectedTotalYen?: number | undefined },
) {
  let row = await lockOnlineOrder(tx, ctx.locationId, id);
  if (row.fulfillmentType !== "pickup")
    throw Errors.conflict(
      "invalid_online_order_transition",
      "Only pickup orders are completed at the counter",
    );
  if (row.status !== "ready")
    throw Errors.conflict(
      "invalid_online_order_transition",
      `Cannot complete a ${row.status} order`,
    );
  if (row.paymentStatus === "unpaid") {
    if (input.amountReceivedYen === undefined)
      throw Errors.unprocessable(
        "payment_required",
        "Collect payment before handing over the order",
        {
          totalYen: row.totalYen,
        },
      );
    if (input.expectedTotalYen !== undefined && input.expectedTotalYen !== row.totalYen)
      throw Errors.conflict("bill_changed", "The amount due changed", { totalYen: row.totalYen });
    row = await collectCash(tx, ctx, row, input.amountReceivedYen);
  }
  await handOverOrderTicket(tx, ctx, row.orderId);
  const next = await transition(tx, row, "complete", staffActor(ctx));
  await recordAudit(tx, ctx, {
    action: "online_order.completed",
    targetType: "online_order",
    targetId: row.id,
  });
  const payment = await getOrderPayment(tx, ctx.locationId, row.orderId);
  return { order: next, payment };
}

// ---------------------------------------------------------------- kitchen integration (injected hook)

/**
 * Kitchen preparation drives the online order: start cooking -> `preparing`, whole ticket ready -> `ready`.
 * Runs inside the kitchen action's transaction (kitchen items already locked; same lock order as everywhere else).
 */
export async function syncOnlineOrderFromKitchen(
  tx: Tx,
  ctx: StaffContext,
  ticket: KitchenTicketView,
): Promise<void> {
  const row = await lockOnlineOrderByOrderId(tx, ticket.orderId);
  if (!row) return;
  const action = actionForKitchenStatus(row.status, ticket.status, row.fulfillmentType);
  if (!action) return;
  let current = row;
  // A ticket can go straight from new to ready (single-item tickets started and finished together).
  if (action === "mark_ready" && current.status === "accepted") {
    current = await transition(tx, current, "start_preparing", staffActor(ctx));
  }
  await transition(tx, current, action, staffActor(ctx));
}
