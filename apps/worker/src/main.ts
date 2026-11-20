/**
 * Worker entry point: transactional-outbox relay.
 *
 * - Wakes on PostgreSQL LISTEN/NOTIFY (low latency) with a polling fallback (missed notifications are harmless).
 * - Uses the dedicated relay DB role, which can only read/mark outbox rows.
 * - Publishes through the Socket.IO Redis emitter, so every API replica delivers to its own sockets.
 * - Safe to run as multiple replicas (FOR UPDATE SKIP LOCKED).
 */
import { createServer } from "node:http";
import { Emitter } from "@socket.io/redis-emitter";
import { loadConfig } from "@restaurant-platform/config";
import {
  createDb,
  createLogger,
  createPool,
  createRedis,
  relayOutboxBatch,
} from "@restaurant-platform/api/worker";

const config = loadConfig(process.env);
const logger = createLogger(config, "worker");
if (!config.DATABASE_RELAY_PASSWORD)
  throw new Error("DATABASE_RELAY_PASSWORD is required for the worker");

const pool = createPool(config, {
  user: config.DATABASE_RELAY_USER,
  password: config.DATABASE_RELAY_PASSWORD,
  max: 3,
});
const db = createDb(pool);
const redis = createRedis(config, "worker-emitter");
const emitter = new Emitter(redis);

const POLL_MS = 1000;
const state = { running: true };
// Read through a function: the flag is flipped asynchronously by the shutdown handler.
const isRunning = (): boolean => state.running;
let wake: (() => void) | null = null;

async function relayLoop(): Promise<void> {
  while (isRunning()) {
    try {
      let processed: number;
      do {
        processed = await relayOutboxBatch(db, emitter);
        if (processed > 0) logger.debug({ processed }, "relayed outbox events");
      } while (processed > 0 && isRunning());
    } catch (err) {
      logger.error({ err }, "outbox relay failed; retrying");
    }
    await new Promise<void>((resolve) => {
      wake = () => {
        resolve();
      };
      setTimeout(resolve, POLL_MS).unref();
    });
    wake = null;
  }
}

const listener = await pool.connect();
await listener.query("LISTEN outbox_events");
listener.on("notification", () => wake?.());

const health = createServer((req, res) => {
  res
    .writeHead(req.url === "/health/live" ? 200 : 404, { "content-type": "application/json" })
    .end('{"status":"ok"}');
});
health.listen(config.WORKER_HEALTH_PORT);

logger.info("worker started");
const loop = relayLoop();

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "worker shutting down");
  state.running = false;
  wake?.();
  await loop;
  listener.release();
  health.close();
  await db.destroy();
  await redis.quit();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
