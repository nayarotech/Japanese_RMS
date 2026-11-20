/**
 * Transactional outbox writer. Call ONLY inside the business transaction, so the event exists
 * if and only if the change committed. The worker relays it to Socket.IO after commit.
 */
import type { Tx } from "../database/db.js";
import type { DomainEvent } from "./event-types.js";

export async function appendOutbox(
  tx: Tx,
  tenantId: string,
  locationId: string,
  event: DomainEvent,
): Promise<void> {
  await tx
    .insertInto("outbox_events")
    .values({
      tenant_id: tenantId,
      location_id: locationId,
      event_type: event.type,
      payload: event.payload,
    })
    .execute();
}
