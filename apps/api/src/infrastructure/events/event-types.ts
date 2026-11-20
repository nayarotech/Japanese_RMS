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
      payload: { ticketId: string; tableSessionId: string; tableName: string };
    }
  | {
      type: "kitchen.item.status_changed";
      payload: {
        ticketId: string;
        tableSessionId: string;
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
      type: "checkout.completed";
      payload: { tableSessionId: string; tableId: string; paymentId: string; receiptId: string };
    };

export type DomainEventType = DomainEvent["type"];
