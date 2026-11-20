/** Pure business rules for dining (table) sessions. No I/O. */
export type TableSessionStatus = "open" | "bill_requested" | "closed";

import { Errors } from "../../../shared/errors/app-error.js";

/** New orders are accepted only while the session is `open` (not during checkout, not after close). */
export function assertAcceptsOrders(status: TableSessionStatus): void {
  if (status === "bill_requested")
    throw Errors.conflict(
      "session_checkout_in_progress",
      "Bill has been requested; ordering is paused",
    );
  if (status === "closed") throw Errors.conflict("session_closed", "This table session is closed");
}

export function assertNotClosed(status: TableSessionStatus): void {
  if (status === "closed") throw Errors.conflict("session_closed", "This table session is closed");
}

export function nextStatusForBillRequest(status: TableSessionStatus): TableSessionStatus {
  if (status !== "open")
    throw Errors.conflict("invalid_session_transition", `Cannot request bill from ${status}`);
  return "bill_requested";
}

export function nextStatusForReopen(status: TableSessionStatus): TableSessionStatus {
  if (status !== "bill_requested")
    throw Errors.conflict("invalid_session_transition", `Cannot reopen from ${status}`);
  return "open";
}
