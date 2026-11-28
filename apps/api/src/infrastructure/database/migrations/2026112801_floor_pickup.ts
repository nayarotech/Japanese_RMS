/**
 * Floor: pickup acknowledgement for ready food.
 *
 * A waiter can say "I have taken this from the kitchen pass" before serving it, so other waiters' Floor screens
 * stop offering the same food. This is an ANNOTATION on a `ready` item, not a new item status: the kitchen item state
 * machine (queued -> preparing -> ready -> served, + voided) is unchanged, so the kitchen display, guest status and
 * online-order hand-over keep working exactly as before.
 *
 *   picked_up_at / picked_up_by: both set or both null; only meaningful while status = 'ready'.
 *
 * Purely additive. Ownership: kitchen -> kitchen_ticket_items.
 */
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
ALTER TABLE app.kitchen_ticket_items
  ADD COLUMN picked_up_at timestamptz,
  ADD COLUMN picked_up_by uuid REFERENCES app.users(id),
  ADD CONSTRAINT kitchen_ticket_items_pickup_pair_ck
    CHECK ((picked_up_at IS NULL) = (picked_up_by IS NULL));

-- Floor board: outstanding items per location (ready / in preparation).
CREATE INDEX kitchen_ticket_items_floor_idx ON app.kitchen_ticket_items (location_id, status)
  WHERE status IN ('queued', 'preparing', 'ready');
`,
    )
    .execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS app.kitchen_ticket_items_floor_idx;
ALTER TABLE app.kitchen_ticket_items DROP CONSTRAINT IF EXISTS kitchen_ticket_items_pickup_pair_ck,
  DROP COLUMN IF EXISTS picked_up_by, DROP COLUMN IF EXISTS picked_up_at`.execute(db);
}
