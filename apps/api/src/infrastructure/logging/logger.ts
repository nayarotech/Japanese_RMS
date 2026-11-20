import type { AppConfig } from "@restaurant-platform/config";
import { pino, type Logger } from "pino";

/** Structured JSON logger with redaction of credentials and personal data. */
export function createLogger(
  config: Pick<AppConfig, "LOG_LEVEL" | "LOG_PRETTY" | "INSTANCE_NAME">,
  name: string,
): Logger {
  return pino({
    name,
    level: config.LOG_LEVEL,
    base: { instance: config.INSTANCE_NAME },
    redact: {
      paths: [
        "req.headers.cookie",
        "req.headers.authorization",
        'req.headers["x-csrf-token"]',
        "*.password",
        "*.passwordHash",
        "*.token",
      ],
      censor: "[redacted]",
    },
    ...(config.LOG_PRETTY
      ? { transport: { target: "pino-pretty", options: { colorize: true } } }
      : {}),
  });
}

export type { Logger };
