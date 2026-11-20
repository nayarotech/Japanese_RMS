import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Assigns a request id (reusing a safe upstream X-Request-Id) and echoes it in the response. */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header("x-request-id");
  req.requestId = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  next();
}
