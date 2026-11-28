/**
 * Real-time domain events (outbox `event_type` == Socket.IO event name).
 * Payloads are intentionally minimal: identifiers and small display data. Clients refetch details
 * over authorized HTTP, which keeps broadcasts low-risk and makes missed events harmless.
 */
export interface ReadyItemSummary {
  kitchenItemId: string;
  nameJa: string;
  nameEn: string | null;
  quantity: number;
  note: string | null;
}

export type DomainEvent =
  | {
      type: "table.session.opened";
      payload: { tableSessionId: string; tableId: string; tableName: string };
    }
  | {
      type: "table.session.updated";
      payload: { tableSessionId: string; tableId: string; status: string };
    }
  | {
      type: "table.session.closed";
      payload: { tableSessionId: string; tableId: string; tableName: string };
    }
  | {
      type: "order.created";
      payload: {
        orderId: string;
        orderNo: number;
        tableSessionId: string;
        tableName: string;
        source: string;
        itemCount: number;
      };
    }
  | {
      type: "order.updated";
      payload: {
        orderId: string;
        tableSessionId: string;
        orderItemId: string;
        change: "edited" | "voided";
      };
    }
  | {
      type: "kitchen.ticket.created";
      payload: {
        ticketId: string;
        orderNo: number;
        source: string;
        tableSessionId: string | null;
        tableName: string | null;
      };
    }
  | {
      type: "kitchen.item.status_changed";
      payload: {
        ticketId: string;
        tableSessionId: string | null;
        kitchenItemIds: string[];
        status: string;
        ticketStatus: string;
      };
    }
  | {
      type: "waiter.food.ready";
      payload: {
        ticketId: string;
        tableSessionId: string;
        tableName: string;
        assignedWaiterId: string | null;
        items: ReadyItemSummary[];
      };
    }
  | {
      type: "waiter.food.served";
      payload: { ticketId: string; tableSessionId: string; kitchenItemIds: string[] };
    }
  | {
      /** A waiter took ready food from the kitchen pass (items stay `ready` until served). */
      type: "waiter.food.picked_up";
      payload: { ticketId: string; tableSessionId: string; kitchenItemIds: string[] };
    }
  | {
      type: "checkout.completed";
      payload: { tableSessionId: string; tableId: string; paymentId: string; receiptId: string };
    }
  | { type: OnlineOrderEventType; payload: OnlineOrderEventPayload };

/** Online (pickup/delivery) order events. Payloads carry ids and status only: never customer personal data. */
export const ONLINE_ORDER_EVENTS = [
  "online.order.created",
  "online.order.accepted",
  "online.order.rejected",
  "online.order.cancelled",
  "online.order.preparing",
  "online.order.ready",
  "online.order.dispatched",
  "online.order.delivered",
  "online.order.completed",
  "online.order.payment_recorded",
] as const;
export type OnlineOrderEventType = (typeof ONLINE_ORDER_EVENTS)[number];

// A type alias (not an interface) so it is assignable to the outbox's JSON record type.
export type OnlineOrderEventPayload = {
  onlineOrderId: string;
  orderNo: number;
  fulfillmentType: "pickup" | "delivery";
  status: string;
  paymentStatus: string;
};

export type DomainEventType = DomainEvent["type"];
