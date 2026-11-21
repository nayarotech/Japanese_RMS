/**
 * Customer order tracking. The customer has no account: placing an order returns a random 256-bit tracking token,
 * scoped to exactly ONE online order, expiring 24 h after the pickup/delivery time and revocable. Only its SHA-256 is
 * stored. The order id alone is never enough to read an order.
 *
 * Transport: the token travels in the URL FRAGMENT of the status page (never sent to servers, logs or Referer) and in
 * the `X-Order-Token` request header (no cookie, so cross-site requests cannot carry it: no CSRF surface).
 */
import type { Db, Tx } from "../../../infrastructure/database/db.js";
import { newSessionToken, sha256 } from "../../../infrastructure/security/tokens.js";
import type { CustomerContext } from "../../../shared/types/access-context.js";

const TRACKING_GRACE_MS = 24 * 60 * 60 * 1000;
const MAX_ACTIVE_TOKENS_PER_ORDER = 5;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export async function issueTrackingToken(
  tx: Tx,
  args: { tenantId: string; locationId: string; onlineOrderId: string; scheduledFor: Date },
): Promise<{ token: string; tokenId: string; expiresAt: Date }> {
  // Idempotent replays mint a fresh token (raw tokens are never stored); keep only the newest few alive.
  const active = await tx
    .selectFrom("online_order_tracking_tokens")
    .select("id")
    .where("online_order_id", "=", args.onlineOrderId)
    .where("tenant_id", "=", args.tenantId)
    .where("revoked_at", "is", null)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .execute();
  const surplus = active.slice(MAX_ACTIVE_TOKENS_PER_ORDER - 1).map((r) => r.id);
  if (surplus.length > 0) {
    await tx
      .updateTable("online_order_tracking_tokens")
      .set({ revoked_at: new Date() })
      .where("id", "in", surplus)
      .execute();
  }
  const token = newSessionToken();
  const expiresAt = new Date(Math.max(args.scheduledFor.getTime(), Date.now()) + TRACKING_GRACE_MS);
  const row = await tx
    .insertInto("online_order_tracking_tokens")
    .values({
      token_hash: sha256(token),
      tenant_id: args.tenantId,
      location_id: args.locationId,
      online_order_id: args.onlineOrderId,
      expires_at: expiresAt,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { token, tokenId: row.id, expiresAt };
}

/** Resolves a tracking token to a customer context bound to one online order, or null. */
export async function authenticateTrackingToken(
  db: Db,
  token: string | undefined,
  meta: { ip: string | null; requestId: string },
): Promise<CustomerContext | null> {
  if (!token || !TOKEN_RE.test(token)) return null;
  const row = await db
    .selectFrom("online_order_tracking_tokens")
    .select(["id", "tenant_id", "location_id", "online_order_id"])
    .where("token_hash", "=", sha256(token))
    .where("revoked_at", "is", null)
    .where("expires_at", ">", new Date())
    .executeTakeFirst();
  if (!row) return null;
  return {
    kind: "customer",
    tenantId: row.tenant_id,
    locationId: row.location_id,
    onlineOrderId: row.online_order_id,
    trackingTokenId: row.id,
    requestId: meta.requestId,
    ip: meta.ip,
  };
}

/** Revokes every tracking token of an order (e.g. a customer reports the link was shared by mistake). */
export async function revokeTrackingTokens(tx: Tx, onlineOrderId: string): Promise<void> {
  await tx
    .updateTable("online_order_tracking_tokens")
    .set({ revoked_at: new Date() })
    .where("online_order_id", "=", onlineOrderId)
    .where("revoked_at", "is", null)
    .execute();
}
