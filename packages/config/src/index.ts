/**
 * @restaurant-platform/config: typed, validated runtime configuration.
 *
 * Parse once at process start (`loadConfig(process.env)`), fail fast on invalid values, then pass the
 * frozen object explicitly. Business code never reads `process.env` directly.
 */
import { z } from "zod";

const bool = z.enum(["true", "false"]).transform((v) => v === "true");

const csv = z.string().transform((v) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const EnvSchema = z.object({
  APP_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  INSTANCE_NAME: z.string().default("local"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  LOG_PRETTY: bool.default(false),

  API_PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(4100),
  APP_PUBLIC_ORIGINS: csv.default(["http://localhost:3000"]),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),

  POSTGRES_HOST: z.string().min(1),
  POSTGRES_PORT: z.coerce.number().int().default(5432),
  POSTGRES_DB: z.string().min(1),
  DATABASE_APP_USER: z.string().min(1),
  DATABASE_APP_PASSWORD: z.string().min(1),
  DATABASE_RELAY_USER: z.string().min(1).default("rp_relay"),
  DATABASE_RELAY_PASSWORD: z.string().min(1).optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(5000),
  DATABASE_SSL_MODE: z.enum(["disable", "require", "verify-full"]).default("disable"),

  REDIS_URL: z.string().min(1),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_TLS: bool.default(false),

  // Secret for HMAC-derived values (CSRF tokens). At least 32 characters; rotate to invalidate CSRF tokens.
  SESSION_SECRET: z.string().min(32),
  SESSION_IDLE_TIMEOUT_MINUTES: z.coerce
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .default(30),
  SESSION_ABSOLUTE_TIMEOUT_HOURS: z.coerce.number().int().min(1).max(72).default(12),
  COOKIE_SECURE: bool.default(true),

  SOCKET_IO_PATH: z.string().default("/socket.io"),
  SHUTDOWN_GRACE_PERIOD_MS: z.coerce.number().int().min(0).default(25000),

  DEFAULT_LOCALE: z.enum(["ja", "en"]).default("ja"),

  // Address geocoding for delivery-area checks. No paid provider is selected yet (docs/architecture/15-online-ordering.md):
  // "disabled" = delivery orders are refused (fail closed); "static_demo" = built-in demo postal codes (dev/test only).
  GEOCODER_PROVIDER: z.enum(["disabled", "static_demo"]).default("disabled"),
  GEOCODER_TIMEOUT_MS: z.coerce.number().int().min(200).max(10_000).default(3000),
  DEFAULT_TIME_ZONE: z.string().default("Asia/Tokyo"),

  // Object storage for menu item photos (docs/architecture/16-menu-item-images.md). Binaries never go to PostgreSQL.
  // "s3" = any S3-compatible service (required in staging/production); "local" = a directory on this machine
  // (single-host development only); "memory" = in-process (tests only).
  STORAGE_DRIVER: z.enum(["s3", "local", "memory"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().min(1).default(".data/storage"),
  STORAGE_ENDPOINT: z.string().optional(),
  STORAGE_REGION: z.string().min(1).default("ap-northeast-1"),
  STORAGE_BUCKET: z.string().optional(),
  STORAGE_ACCESS_KEY_ID: z.string().optional(),
  STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
  STORAGE_FORCE_PATH_STYLE: bool.default(false),
  // Public delivery base URL (CDN or public-read bucket) for stored objects, without a trailing slash.
  // Empty = images are served by the API at /api/v1/public/media/* (works behind the same-origin load balancer).
  STORAGE_PUBLIC_BASE_URL: z
    .string()
    .optional()
    .transform((v) => (v ? v.replace(/\/+$/, "") : undefined)),
  MENU_IMAGE_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(100_000)
    .max(20 * 1024 * 1024)
    .default(5 * 1024 * 1024),
});

export type AppConfig = Readonly<z.infer<typeof EnvSchema>>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`Invalid configuration: ${issues}`);
  }
  const cfg = parsed.data;

  // Production guards: refuse to start with unsafe settings.
  if (cfg.APP_ENV === "staging" || cfg.APP_ENV === "production") {
    const problems: string[] = [];
    if (!cfg.COOKIE_SECURE) problems.push("COOKIE_SECURE must be true");
    if (cfg.DATABASE_SSL_MODE !== "verify-full")
      problems.push("DATABASE_SSL_MODE must be verify-full");
    if (cfg.LOG_PRETTY) problems.push("LOG_PRETTY must be false");
    if (!cfg.REDIS_TLS) problems.push("REDIS_TLS must be true");
    if (cfg.GEOCODER_PROVIDER === "static_demo")
      problems.push("GEOCODER_PROVIDER=static_demo is for development and tests only");
    if (cfg.STORAGE_DRIVER !== "s3")
      problems.push(
        "STORAGE_DRIVER must be s3 (local/memory storage is not shared across replicas)",
      );
    if (cfg.STORAGE_PUBLIC_BASE_URL && !cfg.STORAGE_PUBLIC_BASE_URL.startsWith("https://"))
      problems.push("STORAGE_PUBLIC_BASE_URL must use https");
    if (problems.length > 0)
      throw new ConfigError(`Unsafe ${cfg.APP_ENV} configuration: ${problems.join("; ")}`);
  }
  if (cfg.STORAGE_DRIVER === "s3" && !cfg.STORAGE_BUCKET)
    throw new ConfigError("STORAGE_DRIVER=s3 requires STORAGE_BUCKET");
  // Static keys are optional (the SDK's default chain, e.g. a task role, is preferred) but must come as a pair.
  if (Boolean(cfg.STORAGE_ACCESS_KEY_ID) !== Boolean(cfg.STORAGE_SECRET_ACCESS_KEY))
    throw new ConfigError(
      "STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY must be set together",
    );
  if (cfg.STORAGE_DRIVER === "memory" && cfg.APP_ENV !== "test")
    throw new ConfigError("STORAGE_DRIVER=memory is for tests only");
  return Object.freeze(cfg);
}
