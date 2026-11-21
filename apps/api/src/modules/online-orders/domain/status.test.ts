import { describe, expect, it } from "vitest";
import {
  actionForKitchenStatus,
  assertCanRecordPayment,
  canTransition,
  nextStatus,
  paymentStatusAfterCancellation,
} from "./status.js";

describe("online order state machine", () => {
  it("walks the pickup happy path", () => {
    let s = nextStatus("pending_acceptance", "accept", "pickup");
    s = nextStatus(s, "start_preparing", "pickup");
    s = nextStatus(s, "mark_ready", "pickup");
    expect(nextStatus(s, "complete", "pickup")).toBe("completed");
  });

  it("walks the delivery happy path", () => {
    let s = nextStatus("pending_acceptance", "accept", "delivery");
    s = nextStatus(s, "mark_ready", "delivery"); // kitchen may finish without an explicit start
    s = nextStatus(s, "dispatch", "delivery");
    expect(nextStatus(s, "deliver", "delivery")).toBe("delivered");
  });

  it("rejects transitions that do not fit the fulfilment type", () => {
    expect(canTransition("ready", "dispatch", "pickup")).toBe(false);
    expect(canTransition("ready", "complete", "delivery")).toBe(false);
    expect(() => nextStatus("ready", "dispatch", "pickup")).toThrow(
      expect.objectContaining({ code: "invalid_online_order_transition" }),
    );
  });

  it("only pending orders can be accepted, rejected or cancelled by the customer", () => {
    for (const s of [
      "accepted",
      "preparing",
      "ready",
      "completed",
      "rejected",
      "cancelled",
    ] as const) {
      expect(canTransition(s, "accept", "pickup")).toBe(false);
      expect(canTransition(s, "reject", "pickup")).toBe(false);
      expect(canTransition(s, "cancel_by_customer", "pickup")).toBe(false);
    }
  });

  it("terminal states never move again", () => {
    for (const s of ["completed", "delivered", "rejected", "cancelled"] as const) {
      expect(canTransition(s, "cancel_by_staff", "delivery")).toBe(false);
      expect(canTransition(s, "mark_ready", "delivery")).toBe(false);
    }
  });

  it("follows kitchen status idempotently", () => {
    expect(actionForKitchenStatus("accepted", "preparing", "pickup")).toBe("start_preparing");
    expect(actionForKitchenStatus("preparing", "preparing", "pickup")).toBeNull();
    expect(actionForKitchenStatus("preparing", "ready", "pickup")).toBe("mark_ready");
    expect(actionForKitchenStatus("ready", "ready", "pickup")).toBeNull();
    expect(actionForKitchenStatus("cancelled", "ready", "pickup")).toBeNull();
  });
});

describe("payment state is separate from fulfilment", () => {
  it("allows recording cash only after acceptance and only once", () => {
    expect(() => assertCanRecordPayment("pending_acceptance", "unpaid")).toThrow();
    expect(() => assertCanRecordPayment("delivered", "unpaid")).not.toThrow();
    expect(() => assertCanRecordPayment("ready", "paid")).toThrow(
      expect.objectContaining({ code: "already_paid" }),
    );
    expect(() => assertCanRecordPayment("cancelled", "voided")).toThrow();
  });

  it("never silently drops money on cancellation", () => {
    expect(paymentStatusAfterCancellation("unpaid")).toBe("voided");
    expect(paymentStatusAfterCancellation("paid")).toBe("refund_required");
  });
});
