/**
 * Kitchen item state machine and ticket status derivation. Pure functions.
 *
 *   queued --start--> preparing --ready--> ready --serve--> served
 *      \_______________ void (orders module) ____________/--> voided
 *
 * New tickets are created directly in `preparing` (the kitchen starts on receipt). `queued` and `start` remain only
 * for rows created before that change (migration 2026112901 moved open ones to `preparing`).
 *
 * Preparation (kitchen staff) and serving (floor staff) are separate transitions with separate permissions.
 */
export type KitchenItemStatus = "queued" | "preparing" | "ready" | "served" | "voided";
export type KitchenTicketStatus = "new" | "preparing" | "ready" | "served" | "voided";

import { Errors } from "../../../shared/errors/app-error.js";

export type KitchenAction = "start" | "ready" | "serve";

const TRANSITIONS: Record<KitchenAction, { from: KitchenItemStatus; to: KitchenItemStatus }> = {
  start: { from: "queued", to: "preparing" },
  ready: { from: "preparing", to: "ready" },
  serve: { from: "ready", to: "served" },
};

export function transitionFor(action: KitchenAction): {
  from: KitchenItemStatus;
  to: KitchenItemStatus;
} {
  return TRANSITIONS[action];
}

export function assertTransition(
  current: KitchenItemStatus,
  action: KitchenAction,
): KitchenItemStatus {
  const t = TRANSITIONS[action];
  if (current !== t.from) {
    throw Errors.conflict(
      "invalid_kitchen_transition",
      `Cannot ${action} an item that is ${current}`,
      { current, action },
    );
  }
  return t.to;
}

/** Ticket status is DERIVED from its items, so partial readiness never marks the whole ticket ready. */
export function deriveTicketStatus(items: readonly KitchenItemStatus[]): KitchenTicketStatus {
  const live = items.filter((s) => s !== "voided");
  if (live.length === 0) return "voided";
  if (live.every((s) => s === "served")) return "served";
  if (live.every((s) => s === "ready" || s === "served")) return "ready";
  if (live.some((s) => s !== "queued")) return "preparing";
  return "new";
}

/** Items may be edited (quantity/note) only before the kitchen starts them. */
export function isEditable(status: KitchenItemStatus): boolean {
  return status === "queued";
}
