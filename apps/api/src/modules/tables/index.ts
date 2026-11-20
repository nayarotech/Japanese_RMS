/**
 * tables: restaurant tables, printed QR tokens, and dining (table) sessions.
 *
 * "Occupied" is never a free-floating flag: a table is occupied iff it has a non-closed session,
 * and the database guarantees at most one (partial unique index).
 */
import type { Db, Tx } from "../../infrastructure/database/db.js";
import { nextCounter } from "../../infrastructure/database/db.js";
import type { TableSessionStatus } from "../../infrastructure/database/schema.js";
import { appendOutbox } from "../../infrastructure/events/outbox.js";
import { newQrToken } from "../../infrastructure/security/tokens.js";
import { Errors } from "../../shared/errors/app-error.js";
import type { StaffContext } from "../../shared/types/access-context.js";
import { recordAudit } from "../audit/index.js";
import {
  assertNotClosed,
  nextStatusForBillRequest,
  nextStatusForReopen,
} from "./domain/session-rules.js";

export { assertAcceptsOrders } from "./domain/session-rules.js";

const UNIQUE_VIOLATION = "23505";

export interface TableRow {
  id: string;
  name: string;
  area: string | null;
  capacity: number;
  isActive: boolean;
  sortOrder: number;
  version: number;
}

export interface SessionRow {
  id: string;
  tenantId: string;
  locationId: string;
  tableId: string;
  tableName: string;
  status: TableSessionStatus;
  guestCount: number;
  slipNo: number;
  assignedWaiterId: string | null;
  openedBy: string | null;
  openedAt: Date;
  closedAt: Date | null;
  version: number;
}

// ---------------------------------------------------------------- tables

export async function listTables(
  tx: Tx,
  locationId: string,
  opts: { includeInactive: boolean },
): Promise<TableRow[]> {
  let q = tx
    .selectFrom("restaurant_tables")
    .select(["id", "name", "area", "capacity", "is_active", "sort_order", "version"])
    .where("location_id", "=", locationId);
  if (!opts.includeInactive) q = q.where("is_active", "=", true);
  const rows = await q.orderBy("sort_order").orderBy("name").execute();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    area: r.area,
    capacity: r.capacity,
    isActive: r.is_active,
    sortOrder: r.sort_order,
    version: r.version,
  }));
}

export async function createTable(
  tx: Tx,
  ctx: StaffContext,
  input: {
    name: string;
    capacity: number;
    area?: string | null | undefined;
    sortOrder?: number | undefined;
  },
): Promise<string> {
  try {
    const row = await tx
      .insertInto("restaurant_tables")
      .values({
        tenant_id: ctx.tenantId,
        location_id: ctx.locationId,
        name: input.name,
        capacity: input.capacity,
        area: input.area ?? null,
        sort_order: input.sortOrder ?? 0,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await issueQrToken(tx, ctx.tenantId, ctx.locationId, row.id);
    await recordAudit(tx, ctx, {
      action: "table.created",
      targetType: "table",
      targetId: row.id,
      metadata: { name: input.name },
    });
    return row.id;
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION)
      throw Errors.conflict("table_name_taken", "A table with this name already exists");
    throw err;
  }
}

export async function updateTable(
  tx: Tx,
  ctx: StaffContext,
  tableId: string,
  input: {
    version: number;
    name?: string | undefined;
    capacity?: number | undefined;
    area?: string | null | undefined;
    isActive?: boolean | undefined;
    sortOrder?: number | undefined;
  },
): Promise<void> {
  if (input.isActive === false) {
    const active = await findActiveSessionForTable(tx, tableId);
    if (active)
      throw Errors.conflict(
        "table_occupied",
        "Close the dining session before deactivating the table",
      );
  }
  try {
    const res = await tx
      .updateTable("restaurant_tables")
      .set((eb) => ({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.capacity === undefined ? {} : { capacity: input.capacity }),
        ...(input.area === undefined ? {} : { area: input.area }),
        ...(input.isActive === undefined ? {} : { is_active: input.isActive }),
        ...(input.sortOrder === undefined ? {} : { sort_order: input.sortOrder }),
        version: eb("version", "+", 1),
        updated_at: new Date(),
      }))
      .where("id", "=", tableId)
      .where("location_id", "=", ctx.locationId)
      .where("version", "=", input.version)
      .executeTakeFirst();
    if (res.numUpdatedRows === 0n)
      throw Errors.conflict("version_conflict", "Table was changed by someone else");
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION)
      throw Errors.conflict("table_name_taken", "A table with this name already exists");
    throw err;
  }
  await recordAudit(tx, ctx, {
    action: "table.updated",
    targetType: "table",
    targetId: tableId,
    metadata: { ...input },
  });
}

async function getTableInLocation(tx: Tx, locationId: string, tableId: string) {
  const t = await tx
    .selectFrom("restaurant_tables")
    .select(["id", "name", "is_active"])
    .where("id", "=", tableId)
    .where("location_id", "=", locationId)
    .executeTakeFirst();
  if (!t) throw Errors.notFound("table");
  return t;
}

// ---------------------------------------------------------------- QR tokens (platform lookup table: always filter by tenant)

async function issueQrToken(
  tx: Tx,
  tenantId: string,
  locationId: string,
  tableId: string,
): Promise<string> {
  const token = newQrToken();
  await tx
    .insertInto("table_qr_tokens")
    .values({ token, tenant_id: tenantId, location_id: locationId, table_id: tableId })
    .execute();
  return token;
}

export async function getQrToken(
  tx: Tx,
  ctx: StaffContext,
  tableId: string,
): Promise<{ token: string; issuedAt: Date }> {
  await getTableInLocation(tx, ctx.locationId, tableId);
  const row = await tx
    .selectFrom("table_qr_tokens")
    .select(["token", "issued_at"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("table_id", "=", tableId)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  if (row) return { token: row.token, issuedAt: row.issued_at };
  const token = await issueQrToken(tx, ctx.tenantId, ctx.locationId, tableId);
  return { token, issuedAt: new Date() };
}

/** Reissue: the old printed code stops working immediately. */
export async function rotateQrToken(
  tx: Tx,
  ctx: StaffContext,
  tableId: string,
): Promise<{ token: string }> {
  await getTableInLocation(tx, ctx.locationId, tableId);
  await tx
    .updateTable("table_qr_tokens")
    .set({ revoked_at: new Date() })
    .where("tenant_id", "=", ctx.tenantId)
    .where("table_id", "=", tableId)
    .where("revoked_at", "is", null)
    .execute();
  const token = await issueQrToken(tx, ctx.tenantId, ctx.locationId, tableId);
  await recordAudit(tx, ctx, {
    action: "table.qr_rotated",
    targetType: "table",
    targetId: tableId,
  });
  return { token };
}

/** Public resolution of a scanned QR token (no tenant context yet). */
export async function resolveQrToken(
  db: Db,
  token: string,
): Promise<{ tenantId: string; locationId: string; tableId: string } | null> {
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(token)) return null;
  const row = await db
    .selectFrom("table_qr_tokens")
    .select(["tenant_id", "location_id", "table_id"])
    .where("token", "=", token)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  return row
    ? { tenantId: row.tenant_id, locationId: row.location_id, tableId: row.table_id }
    : null;
}

// ---------------------------------------------------------------- sessions

function sessionSelect(tx: Tx) {
  return tx
    .selectFrom("table_sessions as s")
    .innerJoin("restaurant_tables as t", "t.id", "s.table_id")
    .select([
      "s.id",
      "s.tenant_id",
      "s.location_id",
      "s.table_id",
      "t.name as table_name",
      "s.status",
      "s.guest_count",
      "s.slip_no",
      "s.assigned_waiter_id",
      "s.opened_by",
      "s.opened_at",
      "s.closed_at",
      "s.version",
    ]);
}

type SessionSelectRow = Awaited<
  ReturnType<ReturnType<typeof sessionSelect>["executeTakeFirstOrThrow"]>
>;

function toSession(r: SessionSelectRow): SessionRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    locationId: r.location_id,
    tableId: r.table_id,
    tableName: r.table_name,
    status: r.status,
    guestCount: r.guest_count,
    slipNo: r.slip_no,
    assignedWaiterId: r.assigned_waiter_id,
    openedBy: r.opened_by,
    openedAt: r.opened_at,
    closedAt: r.closed_at,
    version: r.version,
  };
}

export async function findActiveSessionForTable(
  tx: Tx,
  tableId: string,
): Promise<SessionRow | null> {
  const r = await sessionSelect(tx)
    .where("s.table_id", "=", tableId)
    .where("s.status", "<>", "closed")
    .executeTakeFirst();
  return r ? toSession(r) : null;
}

export async function listActiveSessions(tx: Tx, locationId: string): Promise<SessionRow[]> {
  const rows = await sessionSelect(tx)
    .where("s.location_id", "=", locationId)
    .where("s.status", "<>", "closed")
    .execute();
  return rows.map(toSession);
}

export async function getSession(
  tx: Tx,
  locationId: string,
  sessionId: string,
): Promise<SessionRow> {
  const r = await sessionSelect(tx)
    .where("s.id", "=", sessionId)
    .where("s.location_id", "=", locationId)
    .executeTakeFirst();
  if (!r) throw Errors.notFound("table session");
  return toSession(r);
}

/**
 * Locks the session row (`FOR UPDATE`) for the rest of the transaction. Order submission and checkout
 * both take this lock, which serializes "additional order vs. checkout" races on the same table.
 */
export async function lockSession(
  tx: Tx,
  locationId: string,
  sessionId: string,
): Promise<SessionRow> {
  const locked = await tx
    .selectFrom("table_sessions")
    .select("id")
    .where("id", "=", sessionId)
    .where("location_id", "=", locationId)
    .forUpdate()
    .executeTakeFirst();
  if (!locked) throw Errors.notFound("table session");
  return getSession(tx, locationId, sessionId);
}

export async function openSession(
  tx: Tx,
  ctx: StaffContext,
  tableId: string,
  input: { guestCount: number },
): Promise<SessionRow> {
  const table = await getTableInLocation(tx, ctx.locationId, tableId);
  if (!table.is_active) throw Errors.conflict("table_inactive", "Table is not active");
  const slipNo = await nextCounter(tx, ctx.tenantId, ctx.locationId, "slip");
  let id: string;
  try {
    const row = await tx
      .insertInto("table_sessions")
      .values({
        tenant_id: ctx.tenantId,
        location_id: ctx.locationId,
        table_id: tableId,
        guest_count: input.guestCount,
        slip_no: slipNo,
        assigned_waiter_id: ctx.role === "waiter" ? ctx.userId : null,
        opened_by: ctx.userId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    id = row.id;
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
      throw Errors.conflict("table_occupied", "This table already has an active dining session");
    }
    throw err;
  }
  await appendOutbox(tx, ctx.tenantId, ctx.locationId, {
    type: "table.session.opened",
    payload: { tableSessionId: id, tableId, tableName: table.name },
  });
  await recordAudit(tx, ctx, {
    action: "table_session.opened",
    targetType: "table_session",
    targetId: id,
    metadata: { tableId, guestCount: input.guestCount },
  });
  return getSession(tx, ctx.locationId, id);
}

export async function requestBill(tx: Tx, ctx: StaffContext, sessionId: string): Promise<void> {
  const s = await lockSession(tx, ctx.locationId, sessionId);
  await setStatus(tx, ctx, s, nextStatusForBillRequest(s.status), "table_session.bill_requested");
}

export async function reopenSession(tx: Tx, ctx: StaffContext, sessionId: string): Promise<void> {
  const s = await lockSession(tx, ctx.locationId, sessionId);
  await setStatus(tx, ctx, s, nextStatusForReopen(s.status), "table_session.reopened");
}

async function setStatus(
  tx: Tx,
  ctx: StaffContext,
  s: SessionRow,
  status: TableSessionStatus,
  action: string,
): Promise<void> {
  await tx
    .updateTable("table_sessions")
    .set((eb) => ({
      status,
      bill_requested_at: status === "bill_requested" ? new Date() : null,
      version: eb("version", "+", 1),
    }))
    .where("id", "=", s.id)
    .execute();
  await appendOutbox(tx, ctx.tenantId, ctx.locationId, {
    type: "table.session.updated",
    payload: { tableSessionId: s.id, tableId: s.tableId, status },
  });
  await recordAudit(tx, ctx, { action, targetType: "table_session", targetId: s.id });
}

/** Closes a LOCKED session. Callers (checkout, close-empty) must have verified the bill. */
export async function closeLockedSession(tx: Tx, ctx: StaffContext, s: SessionRow): Promise<void> {
  assertNotClosed(s.status);
  await tx
    .updateTable("table_sessions")
    .set((eb) => ({
      status: "closed",
      closed_at: new Date(),
      closed_by: ctx.userId,
      version: eb("version", "+", 1),
    }))
    .where("id", "=", s.id)
    .execute();
  await appendOutbox(tx, ctx.tenantId, ctx.locationId, {
    type: "table.session.closed",
    payload: { tableSessionId: s.id, tableId: s.tableId, tableName: s.tableName },
  });
}

/**
 * Guest scan on an unseated table: open a dining session automatically (no staff step, ADR-0008).
 * Safe under concurrent scans: the one-active-session unique index decides, losers reuse the winner.
 */
export async function openSessionFromQr(
  tx: Tx,
  ref: { tenantId: string; locationId: string; tableId: string },
): Promise<SessionRow> {
  const table = await getTableInLocation(tx, ref.locationId, ref.tableId);
  if (!table.is_active) throw Errors.conflict("table_inactive", "Table is not active");
  const slipNo = await nextCounter(tx, ref.tenantId, ref.locationId, "slip");
  const row = await tx
    .insertInto("table_sessions")
    .values({
      tenant_id: ref.tenantId,
      location_id: ref.locationId,
      table_id: ref.tableId,
      guest_count: 1,
      slip_no: slipNo,
      opened_by: null,
    })
    .onConflict((oc) => oc.column("table_id").where("status", "<>", "closed").doNothing())
    .returning("id")
    .executeTakeFirst();
  if (!row) {
    const existing = await findActiveSessionForTable(tx, ref.tableId);
    if (!existing) throw Errors.conflict("concurrent_update", "Please retry");
    return existing;
  }
  await appendOutbox(tx, ref.tenantId, ref.locationId, {
    type: "table.session.opened",
    payload: { tableSessionId: row.id, tableId: ref.tableId, tableName: table.name },
  });
  return getSession(tx, ref.locationId, row.id);
}

/** Staff action: sign out every guest phone of this session (e.g. misuse); guests can scan again. */
export async function recordGuestDevicesRevoked(
  tx: Tx,
  ctx: StaffContext,
  sessionId: string,
): Promise<void> {
  const s = await getSession(tx, ctx.locationId, sessionId);
  assertNotClosed(s.status);
  await recordAudit(tx, ctx, {
    action: "table_session.guest_devices_revoked",
    targetType: "table_session",
    targetId: s.id,
  });
}

export async function getTableName(tx: Tx, tableId: string): Promise<string> {
  const t = await tx
    .selectFrom("restaurant_tables")
    .select("name")
    .where("id", "=", tableId)
    .executeTakeFirst();
  if (!t) throw Errors.notFound("table");
  return t.name;
}
