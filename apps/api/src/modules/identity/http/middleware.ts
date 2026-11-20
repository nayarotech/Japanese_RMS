import type { NextFunction, Request, Response } from "express";
import type { AppDeps } from "../../../app/deps.js";
import { cookieNames } from "../../../infrastructure/security/cookies.js";
import { csrfTokenFor, safeEqual } from "../../../infrastructure/security/tokens.js";
import { Errors } from "../../../shared/errors/app-error.js";
import { authenticateStaff } from "../application/sessions.js";

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Requires an authenticated staff session; enforces CSRF + Origin on state-changing requests. */
export function requireStaff(deps: AppDeps) {
  const names = cookieNames(deps.config.COOKIE_SECURE);
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = (req.cookies as Record<string, string | undefined>)[names.staff];
    if (!token) throw Errors.unauthenticated();
    const ctx = await authenticateStaff(deps, token, {
      ip: req.ip ?? null,
      requestId: req.requestId,
    });
    if (!ctx) throw Errors.unauthenticated();
    if (UNSAFE.has(req.method)) {
      assertAllowedOrigin(deps, req);
      const sent = req.header("x-csrf-token") ?? "";
      if (!safeEqual(sent, csrfTokenFor(deps.config.SESSION_SECRET, ctx.sessionId)))
        throw Errors.csrf();
      await deps.limits.staffMutationPerSession(ctx.sessionId);
    }
    req.staff = ctx;
    next();
  };
}

/** Rejects cross-site requests: if an Origin header is present it must be an allowed app origin. */
export function assertAllowedOrigin(deps: AppDeps, req: Request): void {
  const origin = req.header("origin");
  if (origin && !deps.config.APP_PUBLIC_ORIGINS.includes(origin)) throw Errors.csrf();
}

export function staff(req: Request) {
  if (!req.staff) throw Errors.unauthenticated();
  return req.staff;
}
