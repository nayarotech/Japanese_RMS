/**
 * Guest (customer) ordering sessions.
 *
 * MODEL (docs/security/qr-ordering.md, ADR-0008): scan-to-order.
 *  - The printed QR token identifies a table. Anyone can view the menu.
 *  - While staff have the table SEATED (open dining session), scanning issues a random guest token
 *    (HttpOnly cookie; only its SHA-256 is stored) bound to exactly ONE dining session.
 *  - The token dies when the session closes (checkout), on expiry, or when staff revoke guest devices,
 *    so a phone can never order onto a later party's bill.
 */
import type { Db, Tx } from "../../infrastructure/database/db.js";
import { withTenantTransaction } from "../../infrastructure/database/db.js";
import { newSessionToken, sha256 } from "../../infrastructure/security/tokens.js";
import type { GuestContext } from "../../shared/types/access-context.js";

export const GUEST_SESSION_TTL_MS = 4 * 60 * 60 * 1000;

export async function createGuestSession(
  tx: Tx,
  args: { tenantId: string; locationId: string; tableSessionId: string; ip: string | null },
): Promise<{ token: string; guestSessionId: string; expiresAt: Date }> {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + GUEST_SESSION_TTL_MS);
  const row = await tx
    .insertInto("guest_sessions")
    .values({
      token_hash: sha256(token),
      tenant_id: args.tenantId,
      location_id: args.locationId,
      table_session_id: args.tableSessionId,
      expires_at: expiresAt,
      ip: args.ip,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { token, guestSessionId: row.id, expiresAt };
}

/** Returns a GuestContext only if the guest token is valid AND its dining session is not closed. */
export async function authenticateGuest(
  db: Db,
  token: string,
  meta: { ip: string | null; requestId: string },
): Promise<GuestContext | null> {
  const row = await db
    .selectFrom("guest_sessions")
    .select(["id", "tenant_id", "location_id", "table_session_id"])
    .where("token_hash", "=", sha256(token))
    .where("revoked_at", "is", null)
    .where("expires_at", ">", new Date())
    .executeTakeFirst();
  if (!row) return null;
  const status = await withTenantTransaction(db, { tenantId: row.tenant_id }, async (tx) => {
    const s = await tx
      .selectFrom("table_sessions")
      .select("status")
      .where("id", "=", row.table_session_id)
      .executeTakeFirst();
    return s?.status ?? "closed";
  });
  if (status === "closed") return null;
  return {
    kind: "guest",
    guestSessionId: row.id,
    tenantId: row.tenant_id,
    locationId: row.location_id,
    tableSessionId: row.table_session_id,
    requestId: meta.requestId,
    ip: meta.ip,
  };
}

/** Revokes every guest credential of a dining session (checkout, close, staff revoke). */
export async function revokeGuestSessionsForTableSession(
  tx: Tx,
  tableSessionId: string,
): Promise<void> {
  await tx
    .updateTable("guest_sessions")
    .set({ revoked_at: new Date() })
    .where("table_session_id", "=", tableSessionId)
    .where("revoked_at", "is", null)
    .execute();
}
