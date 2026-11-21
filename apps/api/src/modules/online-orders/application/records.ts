/**
 * Online order rows: loading, locking and VALIDATED state transitions (status + history + outbox in one place).
 *
 * Concurrency: every mutation locks the row `FOR UPDATE` and re-checks the transition, so two staff members pressing
 * "Accept" at the same time produce exactly one acceptance (the other gets 409). Lock order is always
 * kitchen ticket items -> online order, the same order the kitchen action uses, so the two paths cannot deadlock.
 */
import type { Tx } from "../../../infrastructure/database/db.js";
import type { OnlineOrderEventType } from "../../../infrastructure/events/event-types.js";
import { appendOutbox } from "../../../infrastructure/events/outbox.js";
import { Errors } from "../../../shared/errors/app-error.js";
import { lockOrderTicketItems } from "../../kitchen/index.js";
import {
  type FulfillmentType,
  type OnlineOrderAction,
  type OnlineOrderStatus,
  type OnlinePaymentMethod,
  type OnlinePaymentStatus,
  nextStatus,
} from "../domain/status.js";

export interface OnlineOrderRow {
  id: string;
  tenantId: string;
  locationId: string;
  orderId: string;
  orderNo: number;
  fulfillmentType: FulfillmentType;
  status: OnlineOrderStatus;
  paymentMethod: OnlinePaymentMethod;
  paymentStatus: OnlinePaymentStatus;
  scheduledFor: Date;
  itemsSubtotalYen: number;
  deliveryFeeYen: number;
  taxTotalYen: number;
  totalYen: number;
  taxBreakdown: { rateBp: number; baseYen: number; taxYen: number }[];
  pricesIncludeTax: boolean;
  deliveryDistanceM: number | null;
  rejectionReason: string | null;
  cancellationReason: string | null;
  cancelledBy: "staff" | "customer" | null;
  acceptedAt: Date | null;
  readyAt: Date | null;
  dispatchedAt: Date | null;
  finishedAt: Date | null;
  version: number;
  createdAt: Date;
}

function select(tx: Tx) {
  return tx.selectFrom("online_orders").selectAll();
}

type Raw = Awaited<ReturnType<ReturnType<typeof select>["executeTakeFirstOrThrow"]>>;

export function toRow(r: Raw): OnlineOrderRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    locationId: r.location_id,
    orderId: r.order_id,
    orderNo: r.order_no,
    fulfillmentType: r.fulfillment_type,
    status: r.status,
    paymentMethod: r.payment_method,
    paymentStatus: r.payment_status,
    scheduledFor: r.scheduled_for,
    itemsSubtotalYen: r.items_subtotal_yen,
    deliveryFeeYen: r.delivery_fee_yen,
    taxTotalYen: r.tax_total_yen,
    totalYen: r.total_yen,
    taxBreakdown: r.tax_breakdown,
    pricesIncludeTax: r.prices_include_tax,
    deliveryDistanceM: r.delivery_distance_m,
    rejectionReason: r.rejection_reason,
    cancellationReason: r.cancellation_reason,
    cancelledBy: r.cancelled_by,
    acceptedAt: r.accepted_at,
    readyAt: r.ready_at,
    dispatchedAt: r.dispatched_at,
    finishedAt: r.finished_at,
    version: r.version,
    createdAt: r.created_at,
  };
}

export async function getOnlineOrder(
  tx: Tx,
  locationId: string,
  id: string,
): Promise<OnlineOrderRow> {
  const r = await select(tx)
    .where("id", "=", id)
    .where("location_id", "=", locationId)
    .executeTakeFirst();
  if (!r) throw Errors.notFound("online order");
  return toRow(r);
}

/** Locks (kitchen items first, then) the online order row for the rest of the transaction. */
export async function lockOnlineOrder(
  tx: Tx,
  locationId: string,
  id: string,
): Promise<OnlineOrderRow> {
  const probe = await tx
    .selectFrom("online_orders")
    .select("order_id")
    .where("id", "=", id)
    .where("location_id", "=", locationId)
    .executeTakeFirst();
  if (!probe) throw Errors.notFound("online order");
  await lockOrderTicketItems(tx, probe.order_id);
  const r = await select(tx).where("id", "=", id).forUpdate().executeTakeFirstOrThrow();
  return toRow(r);
}

/** For the kitchen hook: the online order of a kitchen ticket's order (kitchen items are already locked). */
export async function lockOnlineOrderByOrderId(
  tx: Tx,
  orderId: string,
): Promise<OnlineOrderRow | null> {
  const r = await select(tx).where("order_id", "=", orderId).forUpdate().executeTakeFirst();
  return r ? toRow(r) : null;
}

const EVENT_FOR_STATUS: Partial<Record<OnlineOrderStatus, OnlineOrderEventType>> = {
  accepted: "online.order.accepted",
  rejected: "online.order.rejected",
  cancelled: "online.order.cancelled",
  preparing: "online.order.preparing",
  ready: "online.order.ready",
  out_for_delivery: "online.order.dispatched",
  delivered: "online.order.delivered",
  completed: "online.order.completed",
};

export async function emitOnlineEvent(
  tx: Tx,
  row: Pick<
    OnlineOrderRow,
    "id" | "tenantId" | "locationId" | "orderNo" | "fulfillmentType" | "status" | "paymentStatus"
  >,
  type: OnlineOrderEventType,
): Promise<void> {
  await appendOutbox(tx, row.tenantId, row.locationId, {
    type,
    payload: {
      onlineOrderId: row.id,
      orderNo: row.orderNo,
      fulfillmentType: row.fulfillmentType,
      status: row.status,
      paymentStatus: row.paymentStatus,
    },
  });
}

export interface TransitionActor {
  type: "staff" | "customer" | "system";
  id: string | null;
}

export async function recordHistory(
  tx: Tx,
  row: Pick<OnlineOrderRow, "id" | "tenantId" | "locationId">,
  from: OnlineOrderStatus | null,
  to: OnlineOrderStatus,
  actor: TransitionActor,
  reason: string | null,
): Promise<void> {
  await tx
    .insertInto("online_order_status_history")
    .values({
      tenant_id: row.tenantId,
      location_id: row.locationId,
      online_order_id: row.id,
      from_status: from,
      to_status: to,
      actor_type: actor.type,
      actor_id: actor.id,
      reason: reason === null ? null : Array.from(reason).slice(0, 200).join(""),
    })
    .execute();
}

/**
 * Applies a validated transition to a LOCKED row: status (+ timestamps / extra columns), history, outbox event.
 * Invalid transitions throw 409 before anything is written.
 */
export async function transition(
  tx: Tx,
  row: OnlineOrderRow,
  action: OnlineOrderAction,
  actor: TransitionActor,
  extra: {
    reason?: string | null;
    paymentStatus?: OnlinePaymentStatus;
    rejectionReason?: string;
    cancellationReason?: string;
    cancelledBy?: "staff" | "customer";
  } = {},
): Promise<OnlineOrderRow> {
  const to = nextStatus(row.status, action, row.fulfillmentType);
  const now = new Date();
  const finished =
    to === "completed" || to === "delivered" || to === "rejected" || to === "cancelled";
  const updated = await tx
    .updateTable("online_orders")
    .set((eb) => ({
      status: to,
      version: eb("version", "+", 1),
      updated_at: now,
      ...(to === "accepted" ? { accepted_at: now } : {}),
      ...(to === "ready" ? { ready_at: now } : {}),
      ...(to === "out_for_delivery" ? { dispatched_at: now } : {}),
      ...(finished ? { finished_at: now } : {}),
      ...(extra.paymentStatus ? { payment_status: extra.paymentStatus } : {}),
      ...(extra.rejectionReason ? { rejection_reason: extra.rejectionReason } : {}),
      ...(extra.cancellationReason
        ? {
            cancellation_reason: extra.cancellationReason,
            cancelled_by: extra.cancelledBy ?? "staff",
          }
        : {}),
    }))
    .where("id", "=", row.id)
    .where("version", "=", row.version)
    .returningAll()
    .executeTakeFirst();
  if (!updated)
    throw Errors.conflict("concurrent_update", "This order was changed by someone else");
  const next = toRow(updated);
  await recordHistory(tx, row, row.status, to, actor, extra.reason ?? null);
  const event = EVENT_FOR_STATUS[to];
  if (event) await emitOnlineEvent(tx, next, event);
  return next;
}
