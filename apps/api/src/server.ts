/**
 * API process entry point. Stateless: any replica can serve any tenant.
 * Graceful shutdown: not-ready -> stop accepting -> drain sockets -> finish requests -> close pools.
 */
import { createServer } from "node:http";
import { loadConfig } from "@restaurant-platform/config";
import { createApp, type AppState } from "./app.js";
import type { AppDeps } from "./app/deps.js";
import { createDb, createPool } from "./infrastructure/database/db.js";
import { createLogger } from "./infrastructure/logging/logger.js";
import { createRedis } from "./infrastructure/redis/redis.js";
import { DEFAULT_RATE_LIMITS, createRateLimiters } from "./infrastructure/security/rate-limit.js";
import { createSocketServer } from "./infrastructure/websocket/socket-server.js";
import { createGeocoder } from "./modules/integrations/index.js";

const config = loadConfig(process.env);
const logger = createLogger(config, "api");
const pool = createPool(config, {
  user: config.DATABASE_APP_USER,
  password: config.DATABASE_APP_PASSWORD,
  max: config.DATABASE_POOL_MAX,
});
const db = createDb(pool);
const redis = createRedis(config, "api");
const pub = createRedis(config, "api-pub");
const sub = createRedis(config, "api-sub");

const deps: AppDeps = {
  config,
  db,
  redis,
  logger,
  limits: createRateLimiters(redis, DEFAULT_RATE_LIMITS),
  geocoder: createGeocoder(config),
};
const state: AppState = { shuttingDown: false };
const httpServer = createServer(createApp(deps, state));
const realtime = createSocketServer(httpServer, deps, { pub, sub });
deps.realtime = realtime;

httpServer.listen(config.API_PORT, () => {
  logger.info({ port: config.API_PORT }, "api listening");
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  state.shuttingDown = true;
  logger.info({ signal }, "shutting down");
  const force = setTimeout(() => {
    logger.error("forced shutdown after grace period");
    process.exit(1);
  }, config.SHUTDOWN_GRACE_PERIOD_MS);
  force.unref();
  // Clients reconnect to another replica and resync their state from the API.
  await realtime.io.close();
  await new Promise<void>((resolve) => {
    httpServer.close(() => {
      resolve();
    });
  });
  await db.destroy();
  await Promise.allSettled([redis.quit(), pub.quit(), sub.quit()]);
  logger.info("shutdown complete");
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
