import { type NextFunction, type Request, type Response, Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../../../app/deps.js";
import { parseIdempotencyKey } from "../../../infrastructure/database/idempotency.js";
import { cookieNames, sessionCookieOptions } from "../../../infrastructure/security/cookies.js";
import { csrfTokenFor, safeEqual } from "../../../infrastructure/security/tokens.js";
import { Errors } from "../../../shared/errors/app-error.js";
import { parse } from "../../../shared/http/validate.js";
import { assertAllowedOrigin } from "../../identity/http/middleware.js";
import { OrderItemsBody } from "../../orders/index.js";
import {
  authenticateGuest,
  getGuestSessionView,
  getPublicTable,
  joinTable,
  placeGuestOrder,
} from "../index.js";

const QrToken = z.string().regex(/^[A-Za-z0-9_-]{22,64}$/);
function guestOf(req: Request) {
  if (!req.guest) throw Errors.unauthenticated();
  return req.guest;
}

export function guestCsrfToken(secret: string, guestSessionId: string): string {
  return csrfTokenFor(secret, `guest:${guestSessionId}`);
}

export function qrOrderingRoutes(deps: AppDeps): Router {
  const r = Router();
  const names = cookieNames(deps.config.COOKIE_SECURE);

  const optionalGuest = async (req: Request) => {
    const token = (req.cookies as Record<string, string | undefined>)[names.guest];
    return token
      ? authenticateGuest(deps.db, token, { ip: req.ip ?? null, requestId: req.requestId })
      : null;
  };

  const requireGuest = async (req: Request, _res: Response, next: NextFunction) => {
    const guest = await optionalGuest(req);
    if (!guest) throw Errors.unauthenticated();
    if (req.method !== "GET") {
      assertAllowedOrigin(deps, req);
      if (
        !safeEqual(
          req.header("x-csrf-token") ?? "",
          guestCsrfToken(deps.config.SESSION_SECRET, guest.guestSessionId),
        )
      )
        throw Errors.csrf();
    }
    req.guest = guest;
    next();
  };

  r.use("/public", async (req, _res, next) => {
    await deps.limits.publicReadPerIp(req.ip ?? "unknown");
    next();
  });

  r.get("/public/tables/:token", async (req, res) => {
    const token = parse(QrToken, req.params["token"]);
    res.setHeader("Cache-Control", "no-store");
    res.json(await getPublicTable(deps, token, await optionalGuest(req)));
  });

  r.post("/public/tables/:token/join", async (req, res) => {
    assertAllowedOrigin(deps, req);
    const token = parse(QrToken, req.params["token"]);
    parse(z.strictObject({}), req.body ?? {});
    await deps.limits.guestJoinPerIp(req.ip ?? "unknown");
    const guest = await joinTable(deps, token, {
      ip: req.ip ?? null,
      requestId: req.requestId,
    });
    res.cookie(
      names.guest,
      guest.token,
      sessionCookieOptions(deps.config.COOKIE_SECURE, guest.expiresAt.getTime() - Date.now()),
    );
    res
      .status(200)
      .json({ csrfToken: guestCsrfToken(deps.config.SESSION_SECRET, guest.guestSessionId) });
  });

  r.get("/public/session", requireGuest, async (req, res) => {
    const guest = guestOf(req);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ...(await getGuestSessionView(deps, guest)),
      csrfToken: guestCsrfToken(deps.config.SESSION_SECRET, guest.guestSessionId),
    });
  });

  r.post("/public/session/orders", requireGuest, async (req, res) => {
    const guest = guestOf(req);
    const key = parseIdempotencyKey(req.header("idempotency-key"));
    const body = parse(OrderItemsBody, req.body);
    await deps.limits.guestOrderPerSession(guest.guestSessionId);
    const result = await placeGuestOrder(deps, guest, key, body.items);
    if (result.replayed) res.setHeader("Idempotent-Replayed", "true");
    res.status(result.status).json(result.body);
  });

  return r;
}
