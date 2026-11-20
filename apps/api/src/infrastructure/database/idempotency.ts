/**
 * Idempotency for non-idempotent creates (orders, checkout). The record is written in the SAME
 * transaction as the business change: a concurrent duplicate blocks on the primary key until the
 * first commits, then replays the stored response. Same key + different payload => 409.
 */
import { sql } from "kysely";
import { Errors } from "../../shared/errors/app-error.js";
import { requestHash } from "../security/tokens.js";
import type { Tx } from "./db.js";

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

const KEY_RE = /^[A-Za-z0-9_-]{8,100}$/;

export function parseIdempotencyKey(header: string | undefined): string {
  if (!header || !KEY_RE.test(header)) {
    throw Errors.validation({
      header: "Idempotency-Key header (8-100 chars, [A-Za-z0-9_-]) is required",
    });
  }
  return header;
}

export async function withIdempotency<T>(
  tx: Tx,
  args: { tenantId: string; scope: string; key: string; request: unknown },
  fn: () => Promise<{ status: number; body: T }>,
): Promise<IdempotentResult<T>> {
  const hash = requestHash(args.request);
  const inserted = await tx
    .insertInto("idempotency_records")
    .values({
      tenant_id: args.tenantId,
      scope: args.scope,
      key: args.key,
      request_hash: hash,
      response_status: null,
      response_body: null,
    })
    .onConflict((oc) => oc.columns(["tenant_id", "scope", "key"]).doNothing())
    .returning("key")
    .executeTakeFirst();

  if (!inserted) {
    const existing = await tx
      .selectFrom("idempotency_records")
      .select(["request_hash", "response_status", "response_body"])
      .where("tenant_id", "=", args.tenantId)
      .where("scope", "=", args.scope)
      .where("key", "=", args.key)
      .executeTakeFirstOrThrow();
    if (existing.request_hash !== hash) {
      throw Errors.conflict(
        "idempotency_key_reused",
        "Idempotency-Key was already used with a different request",
      );
    }
    if (existing.response_status === null) {
      throw Errors.conflict(
        "idempotency_in_progress",
        "A request with this Idempotency-Key is still in progress",
      );
    }
    return { status: existing.response_status, body: existing.response_body as T, replayed: true };
  }

  const result = await fn();
  await tx
    .updateTable("idempotency_records")
    .set({
      response_status: result.status,
      response_body: sql`${JSON.stringify(result.body)}::jsonb`,
    })
    .where("tenant_id", "=", args.tenantId)
    .where("scope", "=", args.scope)
    .where("key", "=", args.key)
    .execute();
  return { ...result, replayed: false };
}
