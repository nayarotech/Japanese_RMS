/**
 * Public surface for apps/worker (ADR-0005). Only background-processing code is exported here;
 * HTTP and Socket.IO bootstrapping are never part of this entry.
 */
export { relayOutboxBatch, routeEvent, type RoomEmitter } from "./infrastructure/events/relay.js";
export { createDb, createPool } from "./infrastructure/database/db.js";
export { createLogger } from "./infrastructure/logging/logger.js";
export { createRedis } from "./infrastructure/redis/redis.js";
