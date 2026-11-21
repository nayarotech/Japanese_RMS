/** Online-ordering customer client: behaves like the storefront page (quote, then submit with the reviewed total). */
import { randomInt, randomUUID } from "node:crypto";
import request from "supertest";
import { expect } from "vitest";
import type { Harness } from "./harness.js";
import { ORIGIN } from "./harness.js";

type App = Harness["app"];
export interface Line {
  menuItemId: string;
  quantity: number;
  note?: string | null;
}
export interface Address {
  postalCode: string;
  prefecture: string;
  city: string;
  line1: string;
  line2?: string | null;
  instructions?: string | null;
}

/** A fresh Japanese mobile number per order, so the per-phone pending cap never interferes across tests. */
export const randomPhone = () => `090${String(randomInt(10_000_000, 99_999_999))}`;

export const demoAddress = (postalCode: string): Address => ({
  postalCode,
  prefecture: "東京都",
  city: "渋谷区",
  line1: "1-2-3",
  line2: "Sample Bldg 4F",
  instructions: "Ring the bell",
});

export function storefront(app: App, storeToken: string) {
  const post = (path: string) => request(app).post(`/api/v1${path}`).set("Origin", ORIGIN);
  const api = {
    store: () => request(app).get(`/api/v1/public/stores/${storeToken}`),
    quote: (body: object) => post(`/public/stores/${storeToken}/quote`).send(body),
    submit: (body: object, key: string = randomUUID()) =>
      post(`/public/stores/${storeToken}/orders`).set("Idempotency-Key", key).send(body),
    track: (token: string | null) => {
      const r = request(app).get("/api/v1/public/online-orders/current");
      return token ? r.set("X-Order-Token", token) : r;
    },
    cancel: (token: string) =>
      post("/public/online-orders/current/cancel").set("X-Order-Token", token).send({}),

    /** Builds a valid submission body (first available pickup slot, server-quoted total). */
    async body(
      type: "pickup" | "delivery",
      items: Line[],
      opts: { postalCode?: string; phone?: string; name?: string } = {},
    ) {
      const address = type === "delivery" ? demoAddress(opts.postalCode ?? "1500002") : null;
      const quote = await api.quote({ fulfillmentType: type, items, address });
      expect(quote.status, JSON.stringify(quote.body)).toBe(200);
      const store = await api.store();
      const pickupTime: string | null = type === "pickup" ? store.body.pickup.slots[0] : null;
      return {
        fulfillmentType: type,
        items,
        ...(address ? { address } : { pickupTime }),
        contact: { name: opts.name ?? "Taro Yamada", phone: opts.phone ?? randomPhone() },
        paymentMethod: type === "pickup" ? "pay_on_pickup" : "cash_on_delivery",
        expectedTotalYen: quote.body.totalYen as number,
      };
    },

    async place(type: "pickup" | "delivery", items: Line[], opts: { postalCode?: string } = {}) {
      const res = await api.submit(await api.body(type, items, opts));
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body as {
        onlineOrderId: string;
        orderNo: number;
        status: string;
        totalYen: number;
        trackingToken: string;
        scheduledFor: string;
      };
    },
  };
  return api;
}
