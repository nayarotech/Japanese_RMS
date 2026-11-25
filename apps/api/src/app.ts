/**
 * Express application factory (composition root for HTTP). No I/O at import time.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { parseCookie } from "cookie";
import { sql } from "kysely";
import type { AppDeps } from "./app/deps.js";
import { resolveBrandByHost } from "./modules/branding/index.js";
import { identityRoutes } from "./modules/identity/http/routes.js";
import { requireStaff } from "./modules/identity/http/middleware.js";
import { kitchenRoutes } from "./modules/kitchen/http/routes.js";
import { menuMediaRoutes, menuRoutes } from "./modules/menus/http/routes.js";
import {
  onlineOrderPublicRoutes,
  onlineOrderStaffRoutes,
  syncOnlineOrderFromKitchen,
} from "./modules/online-orders/index.js";
import { orderRoutes } from "./modules/orders/http/routes.js";
import { paymentRoutes } from "./modules/payments/http/routes.js";
import { qrOrderingRoutes } from "./modules/qr-ordering/http/routes.js";
import { tableRoutes } from "./modules/tables/http/routes.js";
import { Errors } from "./shared/errors/app-error.js";
import { errorHandler } from "./shared/middleware/error-handler.js";
import { requestContext } from "./shared/middleware/request-context.js";
import "./shared/http/express-augment.js";

export interface AppState {
  shuttingDown: boolean;
}

export function createApp(
  deps: AppDeps,
  state: AppState = { shuttingDown: false },
): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", deps.config.TRUST_PROXY_HOPS);
  app.use(helmet());
  app.use(requestContext);
  app.use(express.json({ limit: "64kb" }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.cookies = parseCookie(req.headers.cookie ?? "");
    next();
  });

  app.get("/health/live", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.get("/health/ready", async (_req, res) => {
    if (state.shuttingDown) {
      res.status(503).json({ status: "draining" });
      return;
    }
    try {
      await sql`SELECT 1`.execute(deps.db);
      await deps.redis.ping();
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });

  const api = express.Router();
  api.get("/public/brand", async (req, res) => {
    const host = typeof req.query["host"] === "string" ? req.query["host"] : req.hostname;
    res.json(await resolveBrandByHost(deps.db, host.slice(0, 253)));
  });
  api.use(identityRoutes(deps));
  api.use(qrOrderingRoutes(deps));
  api.use(onlineOrderPublicRoutes(deps));
  api.use(menuMediaRoutes(deps));
  // Everything below requires an authenticated staff session (and CSRF on mutations).
  api.use(requireStaff(deps));
  api.use(tableRoutes(deps));
  api.use(menuRoutes(deps));
  api.use(orderRoutes(deps));
  // Kitchen progress on an online order's ticket drives that order's status (injected: no kitchen -> online-orders import).
  api.use(kitchenRoutes(deps, { afterOnlineTicketChange: syncOnlineOrderFromKitchen }));
  api.use(paymentRoutes(deps));
  api.use(onlineOrderStaffRoutes(deps));

  app.use("/api/v1", api);
  app.use((_req, _res, next) => {
    next(Errors.notFound("route"));
  });
  app.use(errorHandler(deps.logger));
  return app;
}
