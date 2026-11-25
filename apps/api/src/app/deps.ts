import type { AppConfig } from "@restaurant-platform/config";
import type { Db } from "../infrastructure/database/db.js";
import type { Logger } from "../infrastructure/logging/logger.js";
import type { Redis } from "../infrastructure/redis/redis.js";
import type { RateLimiters } from "../infrastructure/security/rate-limit.js";
import type { ObjectStorage } from "../infrastructure/storage/object-storage.js";
import type { Geocoder } from "../modules/integrations/index.js";

/** Explicit dependencies passed to every module (no DI container, no globals). */
export interface AppDeps {
  config: AppConfig;
  db: Db;
  redis: Redis;
  logger: Logger;
  limits: RateLimiters;
  /** Object storage for binaries (menu photos). Shared by all replicas; never the container filesystem in deployments. */
  storage: ObjectStorage;
  /** Server-side address geocoding for delivery-area checks (disabled = delivery refused). */
  geocoder: Geocoder;
  /** Set once the Socket.IO server exists; used to drop sockets immediately on logout. */
  realtime?: { disconnectStaffSession(sessionId: string): void };
}
