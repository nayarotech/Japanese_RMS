/**
 * audit: append-only record of security-relevant and privileged actions.
 * Written inside the same transaction as the audited change. The app role cannot UPDATE/DELETE.
 */
import type { Tx } from "../../infrastructure/database/db.js";
import type { GuestContext, StaffContext } from "../../shared/types/access-context.js";

export interface AuditEntry {
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

export async function recordAudit(
  tx: Tx,
  actor: StaffContext | GuestContext,
  entry: AuditEntry,
): Promise<void> {
  await tx
    .insertInto("audit_events")
    .values({
      tenant_id: actor.tenantId,
      location_id: actor.locationId,
      actor_type: actor.kind,
      actor_id: actor.kind === "staff" ? actor.userId : actor.guestSessionId,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      metadata: entry.metadata ?? {},
      request_id: actor.requestId,
      ip: actor.ip,
    })
    .execute();
}
