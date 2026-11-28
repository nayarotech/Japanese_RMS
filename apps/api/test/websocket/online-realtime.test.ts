/**
 * Online-order real-time events across TWO API instances sharing Redis: staff notifications, customer tracking sockets
 * (order-scoped token), tenant/permission isolation, and authoritative reconciliation after a reconnect.
 */
import { randomUUID } from "node:crypto";
import { type Server as HttpServer, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Emitter } from "@socket.io/redis-emitter";
import { type Socket, io as connect } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { TenantFixture } from "../../src/infrastructure/database/fixtures.js";
import { relayOutboxBatch } from "../../src/infrastructure/events/relay.js";
import { createRedis } from "../../src/infrastructure/redis/redis.js";
import {
  type RealtimeControl,
  createSocketServer,
} from "../../src/infrastructure/websocket/socket-server.js";
import { loginStaff } from "../helpers/clients.js";
import { type Harness, TEST_PASSWORD, createHarness } from "../helpers/harness.js";
import { storefront } from "../helpers/online.js";

interface Instance {
  http: HttpServer;
  rt: RealtimeControl;
  url: string;
  close(): Promise<void>;
}

let h: Harness;
let A: TenantFixture;
let B: TenantFixture;
let one: Instance;
let two: Instance;
let emitter: Emitter;
let emitterRedis: ReturnType<typeof createRedis>;
const sockets: Socket[] = [];

async function startInstance(): Promise<Instance> {
  const pub = createRedis(h.deps.config, "test-pub");
  const sub = createRedis(h.deps.config, "test-sub");
  const http = createServer(createApp(h.deps));
  const rt = createSocketServer(http, h.deps, { pub, sub });
  await new Promise<void>((resolve) => http.listen(0, resolve));
  const { port } = http.address() as AddressInfo;
  return {
    http,
    rt,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      await rt.io.close();
      await Promise.allSettled([pub.quit(), sub.quit()]);
    },
  };
}

function socketFor(instance: Instance, opts: { cookie?: string; orderToken?: string }): Socket {
  const s = connect(instance.url, {
    path: "/socket.io",
    transports: ["websocket"],
    extraHeaders: opts.cookie ? { cookie: opts.cookie } : {},
    auth: opts.orderToken ? { orderToken: opts.orderToken } : {},
    reconnection: false,
    forceNew: true,
  });
  sockets.push(s);
  return s;
}

function connected(s: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    s.once("session.ready", () => resolve());
    s.once("connect_error", (e) => reject(e));
  });
}

function nextEvent<T = Record<string, unknown>>(
  s: Socket,
  event: string,
  timeoutMs = 3000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    s.once(event, (payload: T) => {
      clearTimeout(t);
      resolve(payload);
    });
  });
}

function collectAll(s: Socket): string[] {
  const seen: string[] = [];
  s.onAny((event: string) => seen.push(event));
  return seen;
}

const relay = async () => {
  await new Promise((r) => setTimeout(r, 50));
  while ((await relayOutboxBatch(h.relayDb, emitter)) > 0) {
    /* drain */
  }
};

beforeAll(async () => {
  h = await createHarness();
  [A, B] = await Promise.all([
    h.fixture({ planCode: "standard", online: true }),
    h.fixture({ planCode: "standard", online: true }),
  ]);
  one = await startInstance();
  two = await startInstance();
  emitterRedis = createRedis(h.deps.config, "test-emitter");
  emitter = new Emitter(emitterRedis);
  await relay(); // flush rows left by earlier test files
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await one.close();
  await two.close();
  await emitterRedis.quit();
  await h.close();
});

describe("online order notifications", () => {
  it("staff on any instance get a new-order alert without personal data; other tenants and roles get nothing", async () => {
    const [aCashier, aKitchen, bOwner] = await Promise.all([
      loginStaff(h.app, A.users.cashier.email, TEST_PASSWORD),
      loginStaff(h.app, A.users.kitchen.email, TEST_PASSWORD),
      loginStaff(h.app, B.users.owner.email, TEST_PASSWORD),
    ]);
    const staffSock = socketFor(two, { cookie: aCashier.cookie });
    const kitchenSock = socketFor(one, { cookie: aKitchen.cookie });
    const bSock = socketFor(one, { cookie: bOwner.cookie });
    await Promise.all([connected(staffSock), connected(kitchenSock), connected(bSock)]);
    const kitchenSeen = collectAll(kitchenSock);
    const bSeen = collectAll(bSock);

    const created = nextEvent(staffSock, "online.order.created");
    const placed = await storefront(h.app, A.storeToken!).place("delivery", [
      { menuItemId: A.menu[0]!.id, quantity: 2 },
    ]);
    await relay();
    const payload = await created;
    expect(payload).toMatchObject({
      onlineOrderId: placed.onlineOrderId,
      orderNo: placed.orderNo,
      fulfillmentType: "delivery",
      status: "pending_acceptance",
    });
    expect(JSON.stringify(payload)).not.toMatch(/Taro|090|渋谷|1500002/);

    // Accepting sends the order to the kitchen display (existing kitchen event).
    const ticket = nextEvent(kitchenSock, "kitchen.ticket.created");
    await aCashier.post(`/online-orders/${placed.onlineOrderId}/accept`);
    await relay();
    expect(await ticket).toMatchObject({
      source: "ONLINE_DELIVERY",
      orderNo: placed.orderNo,
      tableName: null,
    });

    await new Promise((r) => setTimeout(r, 200));
    expect(bSeen).toEqual([]);
    expect(kitchenSeen.filter((e) => e.startsWith("online.order."))).toEqual([]); // kitchen lacks online_orders.view
  });

  it("a customer's tracking socket receives id-only hints for THEIR order only", async () => {
    const shop = storefront(h.app, A.storeToken!);
    const mine = await shop.place("pickup", [{ menuItemId: A.menu[0]!.id, quantity: 2 }]);
    const other = await shop.place("pickup", [{ menuItemId: A.menu[0]!.id, quantity: 2 }]);
    const mySock = socketFor(one, { orderToken: mine.trackingToken });
    const otherSock = socketFor(two, { orderToken: other.trackingToken });
    await Promise.all([connected(mySock), connected(otherSock)]);
    const otherSeen = collectAll(otherSock);
    await relay();

    const manager = await loginStaff(h.app, A.users.manager.email, TEST_PASSWORD);
    const hint = nextEvent(mySock, "online.order.accepted");
    await manager.post(`/online-orders/${mine.onlineOrderId}/accept`);
    await relay();
    expect(await hint).toEqual({ onlineOrderId: mine.onlineOrderId, eventId: expect.any(String) });
    await new Promise((r) => setTimeout(r, 200));
    expect(otherSeen).toEqual([]);
  });

  it("rejects tracking sockets with an invalid or expired token", async () => {
    const bad = socketFor(one, { orderToken: "x".repeat(43) });
    await expect(connected(bad)).rejects.toThrow(/unauthenticated/);
    const placed = await storefront(h.app, A.storeToken!).place("pickup", [
      { menuItemId: A.menu[0]!.id, quantity: 2 },
    ]);
    await h.migratorDb
      .updateTable("online_order_tracking_tokens")
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where("online_order_id", "=", placed.onlineOrderId)
      .execute();
    const expired = socketFor(two, { orderToken: placed.trackingToken });
    await expect(connected(expired)).rejects.toThrow(/unauthenticated/);
  });
});

describe("reconnection", () => {
  it("a customer and a staff device that were offline recover the authoritative state over HTTP", async () => {
    const shop = storefront(h.app, A.storeToken!);
    const placed = await shop.place("pickup", [{ menuItemId: A.menu[1]!.id, quantity: 2 }]);
    const [cashier, kitchen] = await Promise.all([
      loginStaff(h.app, A.users.cashier.email, TEST_PASSWORD),
      loginStaff(h.app, A.users.kitchen.email, TEST_PASSWORD),
    ]);
    const customerSock = socketFor(one, { orderToken: placed.trackingToken });
    const staffSock = socketFor(one, { cookie: cashier.cookie });
    await Promise.all([connected(customerSock), connected(staffSock)]);
    customerSock.disconnect(); // phone loses signal
    staffSock.disconnect(); // tablet restarts

    await cashier.post(`/online-orders/${placed.onlineOrderId}/accept`);
    const detail = (await cashier.get(`/online-orders/${placed.onlineOrderId}`)).body;
    const ticket = (await kitchen.get("/kitchen/tickets")).body.tickets.find(
      (t: { orderId: string }) => t.orderId === detail.orderId,
    );
    await kitchen.post(`/kitchen/tickets/${ticket.id}/ready`);
    await relay(); // events emitted while nobody listened are lost, by design

    const customerBack = socketFor(two, { orderToken: placed.trackingToken });
    const staffBack = socketFor(two, { cookie: cashier.cookie });
    await Promise.all([connected(customerBack), connected(staffBack)]);
    expect((await shop.track(placed.trackingToken)).body.status).toBe("ready");
    const active = (await cashier.get("/online-orders")).body.orders as {
      id: string;
      status: string;
    }[];
    expect(active.find((o) => o.id === placed.onlineOrderId)?.status).toBe("ready");

    // And live updates resume after the reconnect.
    const completed = nextEvent(customerBack, "online.order.completed");
    await cashier.post(
      `/online-orders/${placed.onlineOrderId}/complete`,
      { amountReceivedYen: 2000, expectedTotalYen: placed.totalYen },
      { "Idempotency-Key": randomUUID() },
    );
    await relay();
    await expect(completed).resolves.toMatchObject({ onlineOrderId: placed.onlineOrderId });
  });
});
