import { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../../../app/deps.js";
import { cookieNames, sessionCookieOptions } from "../../../infrastructure/security/cookies.js";
import { csrfTokenFor } from "../../../infrastructure/security/tokens.js";
import { parse } from "../../../shared/http/validate.js";
import { withTenantTransaction } from "../../../infrastructure/database/db.js";
import { resolveEntitlements } from "../../entitlements/index.js";
import { getLocationSettings } from "../../restaurants/index.js";
import { getTenantBrand } from "../../branding/index.js";
import { login, logout } from "../application/sessions.js";
import { assertAllowedOrigin, requireStaff, staff } from "./middleware.js";
import type { StaffContext } from "../../../shared/types/access-context.js";

const LoginBody = z.strictObject({
  email: z.email().max(254),
  password: z.string().min(1).max(200),
  locationId: z.uuid().optional(),
});

export function identityRoutes(deps: AppDeps): Router {
  const r = Router();
  const names = cookieNames(deps.config.COOKIE_SECURE);

  r.post("/auth/login", async (req, res) => {
    assertAllowedOrigin(deps, req);
    const body = parse(LoginBody, req.body);
    await deps.limits.loginPerIp(req.ip ?? "unknown");
    await deps.limits.loginPerEmail(body.email.toLowerCase());
    const result = await login(deps, {
      ...body,
      ip: req.ip ?? null,
      userAgent: req.header("user-agent") ?? null,
      requestId: req.requestId,
    });
    res.cookie(
      names.staff,
      result.token,
      sessionCookieOptions(
        deps.config.COOKIE_SECURE,
        result.absoluteExpiresAt.getTime() - Date.now(),
      ),
    );
    res.status(200).json(await describeSession(deps, result.context));
  });

  r.post("/auth/logout", requireStaff(deps), async (req, res) => {
    const ctx = staff(req);
    await logout(deps, ctx);
    deps.realtime?.disconnectStaffSession(ctx.sessionId);
    res.clearCookie(names.staff, { path: "/" });
    res.status(204).end();
  });

  r.get("/auth/me", requireStaff(deps), async (req, res) => {
    res.json(await describeSession(deps, staff(req)));
  });

  return r;
}

async function describeSession(deps: AppDeps, ctx: StaffContext) {
  return withTenantTransaction(deps.db, { tenantId: ctx.tenantId }, async (tx) => {
    const [location, entitlements, brand] = await Promise.all([
      getLocationSettings(tx, ctx.locationId),
      resolveEntitlements(tx, ctx.locationId),
      getTenantBrand(tx, ctx.tenantId),
    ]);
    return {
      user: { id: ctx.userId, displayName: ctx.displayName },
      role: ctx.role,
      permissions: [...ctx.permissions],
      location: { id: location.id, name: location.name, timeZone: location.timeZone },
      features: [...entitlements.features],
      brand,
      csrfToken: csrfTokenFor(deps.config.SESSION_SECRET, ctx.sessionId),
    };
  });
}
