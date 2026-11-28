/**
 * The kitchen starts preparing as soon as the restaurant receives an order (no "new" column / "start" step).
 * New tickets are created in `preparing` by the application; this migration moves OPEN legacy rows the same way:
 *   items `queued` -> `preparing` (started_at = now), tickets `new` -> `preparing`.
 * Served, ready and voided rows are untouched. Data-only; forward-only.
 */
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
-- FORCE RLS applies to the table owner too: lift it for these maintenance statements only.
ALTER TABLE app.kitchen_ticket_items NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.kitchen_tickets NO FORCE ROW LEVEL SECURITY;
UPDATE app.kitchen_ticket_items
   SET status = 'preparing', started_at = COALESCE(started_at, now()), version = version + 1
 WHERE status = 'queued';
UPDATE app.kitchen_tickets SET status = 'preparing', updated_at = now() WHERE status = 'new';
ALTER TABLE app.kitchen_ticket_items FORCE ROW LEVEL SECURITY;
ALTER TABLE app.kitchen_tickets FORCE ROW LEVEL SECURITY;
`,
    )
    .execute(db);
}

export function down(): Promise<void> {
  return Promise.reject(new Error("Forward-only data migration."));
}
