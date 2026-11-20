import { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../../../app/deps.js";
import { withTenantTransaction } from "../../../infrastructure/database/db.js";
import { parse } from "../../../shared/http/validate.js";
import { requirePermission } from "../../authorization/index.js";
import { requireFeature } from "../../entitlements/index.js";
import { staff } from "../../identity/http/middleware.js";
import { readyCountsBySession } from "../../kitchen/index.js";
import { getBill, listSessionOrders, sessionTotals } from "../../orders/index.js";
import { revokeGuestSessionsForTableSession } from "../../qr-ordering/index.js";
import {
  createTable,
  getQrToken,
  getSession,
  listActiveSessions,
  listTables,
  openSession,
  reopenSession,
  requestBill,
  recordGuestDevicesRevoked,
  rotateQrToken,
  updateTable,
} from "../index.js";

const Id = z.uuid();
const TableBody = z.strictObject({
  name: z.string().trim().min(1).max(20),
  capacity: z.int().min(1).max(50),
  area: z.string().trim().max(40).nullish(),
  sortOrder: z.int().min(0).max(100_000).optional(),
});

export function tableRoutes(deps: AppDeps): Router {
  const r = Router();

  /** Floor overview: every active table with derived occupancy (from sessions) and running totals. */
  r.get("/floor/tables", async (req, res) => {
    const ctx = staff(req);
    requirePermission(ctx, "tables.view");
    const data = await withTenantTransaction(deps.db, ctx, async (tx) => {
      await requireFeature(tx, ctx.locationId, "table_management");
      const [tables, sessions] = await Promise.all([
        listTables(tx, ctx.locationId, { includeInactive: false }),
        listActiveSessions(tx, ctx.locationId),
      ]);
      const ids = sessions.map((s) => s.id);
      const [totals, ready] = await Promise.all([
        sessionTotals(tx, ids),
        readyCountsBySession(tx, ids),
      ]);
      const byTable = new Map(sessions.map((s) => [s.tableId, s]));
      return {
        tables: tables.map((t) => {
          const s = byTable.get(t.id);
          return {
            ...t,
            state: s ? (s.status === "bill_requested" ? "bill_requested" : "occupied") : "free",
            session: s
              ? {
                  id: s.id,
                  status: s.status,
                  guestCount: s.guestCount,
                  slipNo: s.slipNo,
                  openedAt: s.openedAt,
                  assignedWaiterId: s.assignedWaiterId,
                  subtotalYen: totals.get(s.id)?.subtotalYen ?? 0,
                  itemCount: totals.get(s.id)?.itemCount ?? 0,
                  readyCount: ready.get(s.id) ?? 0,
                }
              : null,
          };
        }),
      };
    });
    res.json(data);
  });

  r.get("/tables", async (req, res) => {
    const ctx = staff(req);
    requirePermission(ctx, "tables.manage");
    res.json({
      tables: await withTenantTransaction(deps.db, ctx, (tx) =>
        listTables(tx, ctx.locationId, { includeInactive: true }),
      ),
    });
  });

  r.post("/tables", async (req, res) => {
    const ctx = staff(req);
    requirePermission(ctx, "tables.manage");
    const body = parse(TableBody, req.body);
    const id = await withTenantTransaction(deps.db, ctx, async (tx) => {
      await requireFeature(tx, ctx.locationId, "table_management");
      return createTable(tx, ctx, body);
    });
    res.status(201).json({ id });
  });

  r.patch("/tables/:id", async (req, res) => {
    const ctx = staff(req);
    requirePermission(ctx, "tables.manage");
    const id = parse(Id, req.params["id"]);
    const body = parse(
      TableBody.partial().extend({ version: z.int().min(1), isActive: z.boolean().optional() }),
      req.body,
    );
    await withTenantTransaction(deps.db, ctx, async (tx) => {
      await requireFeature(tx, ctx.locationId, "table_management");
      await updateTable(tx, ctx, id, body);
    });
    res.status(204).end();
  });

  r.get("/tables/:id/qr", async (req, res) => {
    const ctx = staff(req);
    requirePermission(ctx, "tables.manage");
    const id = parse(Id, req.params["id"]);
    res.json(await withTenantTransaction(deps.db, ctx, (tx) => getQrToken(tx, ctx, id)));
  });

  r.post("/tables/:id/qr/rotate", async (req, res) => {
    const ctx = staff(req);
    requirePermission(ctx, "tables.manage");
    const id = parse(Id, req.params["id"]);
    res.json(await withTenantTransaction(deps.db, ctx, (tx) => rotateQrToken(tx, ctx, id)));
  });

  r.post("/tables/:id/sessions", async (req, res) => {
    const ctx = staff(req);
    requirePermission(ctx, "sessions.manage");
    const id = parse(Id, req.params["id"]);
    const body = parse(z.strictObject({ guestCount: z.int().min(1).max(99) }), req.body);
    const session = await withTenantTransaction(deps.db, ctx, async (tx) => {
      await requireFeature(tx, ctx.locationId, "dine_in_pos");
      return openSession(tx, ctx, id, body);
    });
    res.status(201).json({ session });
  });

  r.get("/sessions/:id", async (req, res) => {
    const ctx = staff(req);
    requirePermission(ctx, "tables.view");
    const id = parse(Id, req.params["id"]);
    const data = await withTenantTransaction(deps.db, ctx, async (tx) => {
      const session = await getSession(tx, ctx.locationId, id);
      const [orders, bill] = await Promise.all([
        listSessionOrders(tx, id),
        getBill(tx, ctx.locationId, id),
      ]);
      return { session, orders, bill };
    });
    res.json(data);
  });

  r.post("/sessions/:id/request-bill", async (req, res) => {
    const ctx = staff(req);
    requirePermission(ctx, "sessions.manage");
    const id = parse(Id, req.params["id"]);
    await withTenantTransaction(deps.db, ctx, (tx) => requestBill(tx, ctx, id));
    res.status(204).end();
  });

  r.post("/sessions/:id/reopen", async (req, res) => {
    const ctx = staff(req);
    requirePermission(ctx, "sessions.manage");
    const id = parse(Id, req.params["id"]);
    await withTenantTransaction(deps.db, ctx, (tx) => reopenSession(tx, ctx, id));
    res.status(204).end();
  });

  r.post("/sessions/:id/guests/revoke", async (req, res) => {
    const ctx = staff(req);
    requirePermission(ctx, "sessions.manage");
    const id = parse(Id, req.params["id"]);
    await withTenantTransaction(deps.db, ctx, async (tx) => {
      await recordGuestDevicesRevoked(tx, ctx, id);
      await revokeGuestSessionsForTableSession(tx, id);
    });
    res.status(204).end();
  });

  return r;
}
