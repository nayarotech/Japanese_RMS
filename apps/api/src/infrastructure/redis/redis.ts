import type { AppConfig } from "@restaurant-platform/config";
import { Redis } from "ioredis";

/** Redis is disposable infrastructure (fan-out, rate limits). Never the source of truth. */
export function createRedis(
  config: Pick<AppConfig, "REDIS_URL" | "REDIS_PASSWORD" | "REDIS_TLS">,
  name: string,
): Redis {
  return new Redis(config.REDIS_URL, {
    ...(config.REDIS_PASSWORD ? { password: config.REDIS_PASSWORD } : {}),
    ...(config.REDIS_TLS ? { tls: {} } : {}),
    connectionName: `restaurant-platform:${name}`,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
  });
}

export type { Redis };
