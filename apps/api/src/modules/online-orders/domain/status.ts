/**
 * Online order lifecycle. Pure functions; the database CHECK constraints mirror the important invariants.
 *
 * Four SEPARATE concepts (never folded into one field):
 *  - acceptance + fulfilment: `status` below
 *  - kitchen preparation:     the kitchen ticket (kitchen module); synced into `preparing`/`ready` by the kitchen hook
 *  - payment settlement:      `paymentStatus` (+ an immutable payments row)
 *  - delivery handover:       `out_for_delivery` -> `delivered` (delivery only)
 *
 *   pending_acceptance --accept--> accepted --kitchen start--> preparing --kitchen ready--> ready
 *        |  \--reject--> rejected                                                         |
 *        \--customer cancel--> cancelled          pickup:   ready --complete (paid)--> completed
 *                                                 delivery: ready --dispatch--> out_for_delivery --deliver--> delivered
 *   staff cancel (reason, manager): accepted | preparing | ready | out_for_delivery --> cancelled
 */
import { Errors } from "../../../shared/errors/app-error.js";

export type OnlineOrderStatus =
  | "pending_acceptance"
  | "accepted"
  | "preparing"
  | "ready"
  | "out_for_delivery"
  | "delivered"
  | "completed"
  | "rejected"
  | "cancelled";
export type FulfillmentType = "pickup" | "delivery";
export type OnlinePaymentMethod = "pay_on_pickup" | "cash_on_delivery";
export type OnlinePaymentStatus = "unpaid" | "paid" | "refund_required" | "voided";

export type OnlineOrderAction =
  | "accept"
  | "reject"
  | "start_preparing"
  | "mark_ready"
  | "dispatch"
  | "deliver"
  | "complete"
  | "cancel_by_customer"
  | "cancel_by_staff";

export const TERMINAL_STATUSES: readonly OnlineOrderStatus[] = [
  "completed",
  "delivered",
  "rejected",
  "cancelled",
];

interface Rule {
  from: readonly OnlineOrderStatus[];
  to: OnlineOrderStatus;
  only?: FulfillmentType;
}

const RULES: Record<OnlineOrderAction, Rule> = {
  accept: { from: ["pending_acceptance"], to: "accepted" },
  reject: { from: ["pending_acceptance"], to: "rejected" },
  cancel_by_customer: { from: ["pending_acceptance"], to: "cancelled" },
  start_preparing: { from: ["accepted"], to: "preparing" },
  mark_ready: { from: ["accepted", "preparing"], to: "ready" },
  dispatch: { from: ["ready"], to: "out_for_delivery", only: "delivery" },
  deliver: { from: ["out_for_delivery"], to: "delivered", only: "delivery" },
  complete: { from: ["ready"], to: "completed", only: "pickup" },
  cancel_by_staff: {
    from: ["accepted", "preparing", "ready", "out_for_delivery"],
    to: "cancelled",
  },
};

export function isTerminal(status: OnlineOrderStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(
  current: OnlineOrderStatus,
  action: OnlineOrderAction,
  type: FulfillmentType,
): boolean {
  const rule = RULES[action];
  return rule.from.includes(current) && (rule.only === undefined || rule.only === type);
}

/** Returns the next status or throws 409 `invalid_online_order_transition`. */
export function nextStatus(
  current: OnlineOrderStatus,
  action: OnlineOrderAction,
  type: FulfillmentType,
): OnlineOrderStatus {
  if (!canTransition(current, action, type)) {
    throw Errors.conflict(
      "invalid_online_order_transition",
      `Cannot ${action} a ${type} order that is ${current}`,
      { current, action },
    );
  }
  return RULES[action].to;
}

/**
 * Kitchen preparation drives `preparing` / `ready`. Returns the action to apply, or null when the online order is
 * already at or past that point (idempotent: repeated or out-of-order kitchen events never fail the kitchen action).
 */
export function actionForKitchenStatus(
  current: OnlineOrderStatus,
  ticketStatus: string,
  type: FulfillmentType,
): OnlineOrderAction | null {
  if (ticketStatus === "preparing" && canTransition(current, "start_preparing", type))
    return "start_preparing";
  if (ticketStatus === "ready" && canTransition(current, "mark_ready", type)) return "mark_ready";
  return null;
}

/** Payment may be recorded once the restaurant has committed to the order and before it is closed without payment. */
export function assertCanRecordPayment(
  status: OnlineOrderStatus,
  paymentStatus: OnlinePaymentStatus,
): void {
  if (paymentStatus === "paid")
    throw Errors.conflict("already_paid", "Payment has already been recorded for this order");
  if (paymentStatus !== "unpaid" || status === "pending_acceptance" || isTerminalUnpaid(status)) {
    throw Errors.conflict("payment_not_allowed", `Cannot record payment for a ${status} order`, {
      status,
      paymentStatus,
    });
  }
}

function isTerminalUnpaid(status: OnlineOrderStatus): boolean {
  return status === "rejected" || status === "cancelled" || status === "completed";
}

/** Rejection/cancellation never silently drops money: a paid order is flagged for refund. */
export function paymentStatusAfterCancellation(current: OnlinePaymentStatus): OnlinePaymentStatus {
  return current === "paid" || current === "refund_required" ? "refund_required" : "voided";
}

export function paymentMethodFor(type: FulfillmentType): OnlinePaymentMethod {
  return type === "pickup" ? "pay_on_pickup" : "cash_on_delivery";
}

/** Cancelling after the kitchen has started is a manager decision (food may be wasted). */
export function cancellationNeedsManager(status: OnlineOrderStatus): boolean {
  return status === "preparing" || status === "ready" || status === "out_for_delivery";
}
