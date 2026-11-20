import type { NextFunction, Request, Response } from "express";
import type { Logger } from "../../infrastructure/logging/logger.js";
import { AppError } from "../errors/app-error.js";

interface PgError {
  code?: string;
  constraint?: string;
}

/** Maps errors to the API error envelope. Never leaks stack traces or internals to clients. */
export function errorHandler(logger: Logger) {
  // Express identifies error handlers by arity, so the unused 4th parameter must stay.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    let appError: AppError;
    if (err instanceof AppError) {
      appError = err;
    } else if (isBodyParserError(err)) {
      appError = new AppError(400, "invalid_body", "Malformed request body");
    } else if ((err as PgError).code === "40001" || (err as PgError).code === "40P01") {
      appError = new AppError(409, "concurrent_update", "Concurrent update, please retry");
    } else {
      logger.error({ err, requestId: req.requestId, path: req.path }, "unhandled error");
      appError = new AppError(500, "internal_error", "Internal error");
    }
    if (appError.status === 429 && typeof appError.details?.["retryAfterSeconds"] === "number") {
      res.setHeader("Retry-After", String(appError.details["retryAfterSeconds"]));
    }
    res.status(appError.status).json({
      error: {
        code: appError.code,
        message: appError.message,
        requestId: req.requestId,
        details: appError.details,
      },
    });
  };
}

function isBodyParserError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "type" in err &&
    typeof err.type === "string" &&
    err.type.startsWith("entity.")
  );
}
