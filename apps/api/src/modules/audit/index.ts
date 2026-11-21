/**
 * audit: append-only record of security-relevant and privileged actions.
 * Written inside the same transaction as the audited change. The app role cannot UPDATE/DELETE.
 */
import type { Tx } from "../../infrastructure/database/db.js";
import type {
  CustomerContext,
  GuestContext,
  StaffContext,
} from "../../shared/types/access-context.js";

export interface AuditEntry {
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

export async function recordAudit(
  tx: Tx,
  actor: StaffContext | GuestContext | CustomerContext,
  entry: AuditEntry,
): Promise<void> {
  // Anonymous customers (QR guests and online customers) are both recorded as actor_type "guest".
  const actorId =
    actor.kind === "staff"
      ? actor.userId
      : actor.kind === "guest"
        ? actor.guestSessionId
        : actor.trackingTokenId;
  await tx
    .insertInto("audit_events")
    .values({
      tenant_id: actor.tenantId,
      location_id: actor.locationId,
      actor_type: actor.kind === "staff" ? "staff" : "guest",
      actor_id: actorId,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      metadata:
        actor.kind === "customer"
          ? { channel: "online", ...entry.metadata }
          : (entry.metadata ?? {}),
      request_id: actor.requestId,
      ip: actor.ip,
    })
    .execute();
}
