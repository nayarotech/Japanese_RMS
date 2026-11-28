/**
 * Real-time delivery across TWO API instances sharing Redis: authenticated sockets, server-assigned
 * tenant/location rooms, outbox relay via the Redis emitter (as the worker does), waiter alerts,
 * missed-event reconciliation and socket auth/origin checks.
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
import { type StaffClient, joinAsGuest, loginStaff } from "../helpers/clients.js";
import { type Harness, TEST_PASSWORD, createHarness } from "../helpers/harness.js";

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

function socketFor(
  instance: Instance,
  cookie: string | null,
  headers: Record<string, string> = {},
): Socket {
  const s = connect(instance.url, {
    path: "/socket.io",
    transports: ["websocket"],
    extraHeaders: { ...(cookie ? { cookie } : {}), ...headers },
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
  // Let Redis adapter subscriptions settle, then relay everything pending (like the worker loop).
  await new Promise((r) => setTimeout(r, 50));
  while ((await relayOutboxBatch(h.relayDb, emitter)) > 0) {
    /* drain */
  }
};

beforeAll(async () => {
  h = await createHarness();
  A = await h.fixture();
  B = await h.fixture();
  one = await startInstance();
  two = await startInstance();
  emitterRedis = createRedis(h.deps.config, "test-emitter");
  emitter = new Emitter(emitterRedis);
  h.deps.realtime = one.rt; // HTTP logout handled by instance one
  await relay(); // flush rows left by earlier test files
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await one.close();
  await two.close();
  await emitterRedis.quit();
  await h.close();
});

describe("multi-instance delivery and tenant room isolation", () => {
  it("an order on instance-agnostic HTTP reaches tenant A devices on BOTH instances and nobody in tenant B", async () => {
    const [aCashier, aKitchen, bOwner] = await Promise.all([
      loginStaff(h.app, A.users.cashier.email, TEST_PASSWORD),
      loginStaff(h.app, A.users.kitchen.email, TEST_PASSWORD),
      loginStaff(h.app, B.users.owner.email, TEST_PASSWORD),
    ]);
    const posSocket = socketFor(one, aCashier.cookie);
    const kitchenSocket = socketFor(two, aKitchen.cookie);
    const bSocket = socketFor(two, bOwner.cookie);
    await Promise.all([connected(posSocket), connected(kitchenSocket), connected(bSocket)]);
    const bSeen = collectAll(bSocket);
    const kitchenSeen = collectAll(kitchenSocket);

    const session = (await aCashier.post(`/tables/${A.tables[0]!.id}/sessions`, { guestCount: 2 }))
      .body.session;
    await aCashier.post(
      `/sessions/${session.id}/orders`,
      { items: [{ menuItemId: A.menu[1]!.id, quantity: 1, note: "Less spicy" }] },
      { "Idempotency-Key": randomUUID() },
    );

    const posEvent = nextEvent(posSocket, "order.created");
    const ticketEvent = nextEvent(kitchenSocket, "kitchen.ticket.created");
    await relay();
    expect(await posEvent).toMatchObject({
      tableSessionId: session.id,
      tableName: "A-1",
      source: "STAFF_POS",
    });
    expect(await ticketEvent).toMatchObject({ tableSessionId: session.id });

    await new Promise((r) => setTimeout(r, 200));
    expect(bSeen).toEqual([]); // tenant B received nothing
    expect(kitchenSeen).not.toContain("order.created"); // kitchen only gets kitchen events
  });

  it("guest sockets receive only id-only hints for their own dining session", async () => {
    const cashier = await loginStaff(h.app, A.users.cashier.email, TEST_PASSWORD);
    const s1 = (await cashier.post(`/tables/${A.tables[1]!.id}/sessions`, { guestCount: 1 })).body
      .session;
    await cashier.post(`/tables/${A.tables[2]!.id}/sessions`, { guestCount: 1 });
    const g1 = await joinAsGuest(h.app, A.tables[1]!.qrToken);
    const g2 = await joinAsGuest(h.app, A.tables[2]!.qrToken);
    const sock1 = socketFor(one, g1.cookie);
    const sock2 = socketFor(two, g2.cookie);
    await Promise.all([connected(sock1), connected(sock2)]);
    const seen2 = collectAll(sock2);

    await g1.order([{ menuItemId: A.menu[0]!.id, quantity: 1 }]);
    const hint = nextEvent(sock1, "order.created");
    await relay();
    expect(await hint).toEqual({ tableSessionId: s1.id, eventId: expect.any(String) });
    await new Promise((r) => setTimeout(r, 200));
    expect(seen2).toEqual([]);
  });
});

describe("waiter notifications and reconciliation", () => {
  async function setupReadyFlow(openedBy: StaffClient, tableIndex: number) {
    const kitchen = await loginStaff(h.app, A.users.kitchen.email, TEST_PASSWORD);
    const session = (
      await openedBy.post(`/tables/${A.tables[tableIndex]!.id}/sessions`, { guestCount: 2 })
    ).body.session;
    const order = await openedBy.post(
      `/sessions/${session.id}/orders`,
      {
        items: [
          { menuItemId: A.menu[1]!.id, quantity: 1, note: "Extra noodles" },
          { menuItemId: A.menu[2]!.id, quantity: 1 },
        ],
      },
      { "Idempotency-Key": randomUUID() },
    );
    const first = order.body.items[0];
    return { session, kitchen, first };
  }

  it("the assigned waiter receives a food-ready alert with table and items (partial readiness)", async () => {
    const waiter = await loginStaff(h.app, A.users.waiter.email, TEST_PASSWORD);
    const { kitchen, first } = await setupReadyFlow(waiter, 3);
    const waiterSocket = socketFor(two, waiter.cookie);
    await connected(waiterSocket);
    await relay();

    const alert = nextEvent<{ tableName: string; items: { note: string }[] }>(
      waiterSocket,
      "waiter.food.ready",
    );
    await kitchen.post(`/kitchen/items/${first.kitchenItemId}/ready`);
    await relay();
    const payload = await alert;
    expect(payload.tableName).toBe("A-4");
    expect(payload.items).toEqual([
      expect.objectContaining({ note: "Extra noodles", quantity: 1 }),
    ]);
  });

  it("without an assigned waiter, all floor staff are notified (not cashiers without floor.serve)", async () => {
    const cashier = await loginStaff(h.app, A.users.cashier.email, TEST_PASSWORD);
    const waiter = await loginStaff(h.app, A.users.waiter.email, TEST_PASSWORD);
    const { kitchen, first } = await setupReadyFlow(cashier, 4);
    const waiterSocket = socketFor(one, waiter.cookie);
    const cashierSocket = socketFor(two, cashier.cookie);
    await Promise.all([connected(waiterSocket), connected(cashierSocket)]);
    await relay();
    const cashierSeen = collectAll(cashierSocket);

    const alert = nextEvent(waiterSocket, "waiter.food.ready");
    await kitchen.post(`/kitchen/items/${first.kitchenItemId}/ready`);
    await relay();
    expect(await alert).toMatchObject({ tableName: "A-5", assignedWaiterId: null });
    await new Promise((r) => setTimeout(r, 200));
    expect(cashierSeen).not.toContain("waiter.food.ready");
  });

  it("Floor devices stay in sync across instances: ready, picked up and served reach every waiter, not tenant B", async () => {
    const waiter = await loginStaff(h.app, A.users.waiter.email, TEST_PASSWORD);
    const manager = await loginStaff(h.app, A.users.manager.email, TEST_PASSWORD);
    const bWaiter = await loginStaff(h.app, B.users.waiter.email, TEST_PASSWORD);
    const { kitchen, first } = await setupReadyFlow(waiter, 8); // C-1 (A-tables are used by other tests)
    const waiterSocket = socketFor(one, waiter.cookie);
    const managerSocket = socketFor(two, manager.cookie); // a second waiter device on the other instance
    const bSocket = socketFor(one, bWaiter.cookie);
    await Promise.all([connected(waiterSocket), connected(managerSocket), connected(bSocket)]);
    await relay();
    const bSeen = collectAll(bSocket);

    const readyOnOther = nextEvent(managerSocket, "kitchen.item.status_changed");
    await kitchen.post(`/kitchen/items/${first.kitchenItemId}/ready`);
    await relay();
    expect(await readyOnOther).toMatchObject({ status: "ready" });

    const pickedOnOther = nextEvent(managerSocket, "waiter.food.picked_up");
    expect(
      (await waiter.post("/floor/items/pickup", { kitchenItemIds: [first.kitchenItemId] })).status,
    ).toBe(200);
    await relay();
    expect(await pickedOnOther).toMatchObject({ kitchenItemIds: [first.kitchenItemId] });

    const servedOnOther = nextEvent(managerSocket, "waiter.food.served");
    expect(
      (await waiter.post("/floor/items/serve", { kitchenItemIds: [first.kitchenItemId] })).status,
    ).toBe(200);
    await relay();
    expect(await servedOnOther).toMatchObject({ kitchenItemIds: [first.kitchenItemId] });
    // The other device's next read no longer offers the food.
    const board = await manager.get("/floor/board");
    expect(
      (board.body.ready as { kitchenItemId: string }[]).map((i) => i.kitchenItemId),
    ).not.toContain(first.kitchenItemId);
    await new Promise((r) => setTimeout(r, 200));
    expect(bSeen).toEqual([]);
  });

  it("a waiter who was offline when food became ready recovers it from the backend after reconnecting", async () => {
    const waiter = await loginStaff(h.app, A.users.waiter.email, TEST_PASSWORD);
    const { kitchen, first } = await setupReadyFlow(waiter, 5);
    const s = socketFor(one, waiter.cookie);
    await connected(s);
    s.disconnect(); // device goes offline

    await kitchen.post(`/kitchen/items/${first.kitchenItemId}/ready`);
    await relay(); // event emitted while nobody is listening: it is lost, by design

    const back = socketFor(two, waiter.cookie); // reconnects (to another instance)
    await connected(back);
    const ready = await waiter.get("/floor/ready-items");
    expect(ready.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kitchenItemId: first.kitchenItemId,
          tableName: "A-6",
          note: "Extra noodles",
        }),
      ]),
    );
  });
});

describe("socket authentication", () => {
  it("rejects connections without a valid session or from a foreign origin", async () => {
    const anon = socketFor(one, null);
    await expect(connected(anon)).rejects.toThrow();
    const forged = socketFor(one, "rp_sid=not-a-real-token");
    await expect(connected(forged)).rejects.toThrow(/unauthenticated/);
    const cashier = await loginStaff(h.app, A.users.cashier.email, TEST_PASSWORD);
    const evil = socketFor(one, cashier.cookie, { origin: "https://evil.example" });
    await expect(connected(evil)).rejects.toThrow();
  });

  it("a stale staff cookie does not block a valid guest credential (falls back to guest)", async () => {
    const cashier = await loginStaff(h.app, A.users.cashier.email, TEST_PASSWORD);
    await cashier.post(`/tables/${A.tables[7]!.id}/sessions`, { guestCount: 1 });
    const guest = await joinAsGuest(h.app, A.tables[7]!.qrToken);
    const s = socketFor(one, `rp_sid=stale-token; ${guest.cookie}`);
    await expect(connected(s)).resolves.toBeUndefined();
  });

  it("logout disconnects the user's sockets on every instance", async () => {
    const manager = await loginStaff(h.app, A.users.manager.email, TEST_PASSWORD);
    const s = socketFor(two, manager.cookie);
    await connected(s);
    const gone = new Promise<void>((resolve) => s.once("disconnect", () => resolve()));
    // Logout is handled by instance ONE; the socket lives on instance TWO.
    expect((await manager.post("/auth/logout")).status).toBe(204);
    await gone;
    expect(s.connected).toBe(false);
  });
});

describe("outbox relay (worker) safety", () => {
  it("competing relays never deliver the same event twice and never emit uncommitted rows", async () => {
    await relay();
    const cashier = await loginStaff(h.app, A.users.cashier.email, TEST_PASSWORD);
    const session = (await cashier.post(`/tables/${A.tables[6]!.id}/sessions`, { guestCount: 1 }))
      .body.session;
    for (let i = 0; i < 5; i++) {
      await cashier.post(
        `/sessions/${session.id}/orders`,
        { items: [{ menuItemId: A.menu[0]!.id, quantity: 1 }] },
        { "Idempotency-Key": randomUUID() },
      );
    }
    const delivered: string[] = [];
    const counting = {
      to: (room: string | string[]) => ({
        emit: (event: string, payload: { eventId: string }) =>
          delivered.push(`${event}:${payload.eventId}:${String(room)}`),
      }),
    };
    const results = await Promise.all(
      [1, 2, 3].map(() => relayOutboxBatch(h.relayDb, counting, 3)),
    );
    while ((await relayOutboxBatch(h.relayDb, counting, 3)) > 0) {
      /* drain */
    }
    expect(results.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    const created = delivered.filter((d) => d.startsWith("order.created:"));
    expect(new Set(created).size).toBe(created.length); // no (event, room) delivered twice
    expect(new Set(created.map((d) => d.split(":")[1])).size).toBe(5); // all five orders delivered
  });
});
