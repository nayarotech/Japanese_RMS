/**
 * payments: restaurant checkout (diners paying the restaurant). NOT SaaS subscription billing.
 * Initial scope: full cash settlement of a dining session, receipt issuance, table release.
 */
import type { Tx } from "../../infrastructure/database/db.js";
import { nextCounter } from "../../infrastructure/database/db.js";
import { appendOutbox } from "../../infrastructure/events/outbox.js";
import { Errors } from "../../shared/errors/app-error.js";
import type { StaffContext } from "../../shared/types/access-context.js";
import { recordAudit } from "../audit/index.js";
import { getTenantBrand } from "../branding/index.js";
import { getBill } from "../orders/index.js";
import { revokeGuestSessionsForTableSession } from "../qr-ordering/index.js";
import { getLocationSettings } from "../restaurants/index.js";
import { closeLockedSession, lockSession } from "../tables/index.js";

export const MAX_CASH_RECEIVED_YEN = 10_000_000;

export interface CheckoutResult {
  paymentId: string;
  receiptId: string;
  receiptNo: number;
  amountDueYen: number;
  amountReceivedYen: number;
  changeYen: number;
}

/**
 * Settles a dining session in cash.
 *
 * Concurrency: the session row is locked FOR UPDATE (same lock as order submission), so an additional
 * order and a checkout on the same table are serialized. `expectedTotalYen` is the total the cashier
 * reviewed; if any order changed the bill in the meantime the checkout is rejected (409 bill_changed)
 * instead of settling an amount nobody reviewed. A partial unique index guarantees one settlement per
 * session even if two cashiers race; callers also use an Idempotency-Key for safe retries.
 */
export async function checkoutCash(
  tx: Tx,
  ctx: StaffContext,
  tableSessionId: string,
  input: { amountReceivedYen: number; expectedTotalYen: number },
): Promise<CheckoutResult> {
  const session = await lockSession(tx, ctx.locationId, tableSessionId);
  if (session.status === "closed")
    throw Errors.conflict("session_closed", "This table session is already settled");

  const bill = await getBill(tx, ctx.locationId, tableSessionId);
  if (bill.lines.length === 0 || bill.totalYen <= 0) {
    throw Errors.unprocessable(
      "nothing_to_pay",
      "There is nothing to pay; close the empty session instead",
    );
  }
  if (bill.totalYen !== input.expectedTotalYen) {
    throw Errors.conflict("bill_changed", "The bill changed since it was reviewed", {
      totalYen: bill.totalYen,
    });
  }
  if (input.amountReceivedYen < bill.totalYen) {
    throw Errors.unprocessable("insufficient_cash", "Amount received is less than the amount due", {
      totalYen: bill.totalYen,
      shortByYen: bill.totalYen - input.amountReceivedYen,
    });
  }
  const changeYen = input.amountReceivedYen - bill.totalYen;

  const payment = await tx
    .insertInto("payments")
    .values({
      tenant_id: ctx.tenantId,
      location_id: ctx.locationId,
      table_session_id: tableSessionId,
      method: "cash",
      amount_due_yen: bill.totalYen,
      amount_received_yen: input.amountReceivedYen,
      change_yen: changeYen,
      received_by: ctx.userId,
    })
    .returning(["id", "created_at"])
    .executeTakeFirstOrThrow();

  const [location, brand] = await Promise.all([
    getLocationSettings(tx, ctx.locationId),
    getTenantBrand(tx, ctx.tenantId),
  ]);
  const receiptNo = await nextCounter(tx, ctx.tenantId, ctx.locationId, "receipt");
  const receipt = await tx
    .insertInto("receipts")
    .values({
      tenant_id: ctx.tenantId,
      location_id: ctx.locationId,
      payment_id: payment.id,
      table_session_id: tableSessionId,
      receipt_no: receiptNo,
      // Immutable snapshot of what was charged. Layout/legal fields pending the approved receipt spec.
      body: {
        brandName: brand.displayName,
        locationName: location.name,
        header: location.receiptHeader,
        footer: location.receiptFooter,
        timeZone: location.timeZone,
        tableName: session.tableName,
        slipNo: session.slipNo,
        issuedAt: payment.created_at.toISOString(),
        lines: bill.lines.map((l) => ({
          nameJa: l.nameJa,
          nameEn: l.nameEn,
          note: l.note,
          unitPriceYen: l.unitPriceYen,
          quantity: l.quantity,
          lineTotalYen: l.lineTotalYen,
          taxRateBp: l.taxRateBp,
        })),
        subtotalYen: bill.subtotalYen,
        taxBreakdown: bill.taxBreakdown,
        taxTotalYen: bill.taxTotalYen,
        totalYen: bill.totalYen,
        pricesIncludeTax: bill.pricesIncludeTax,
        payment: { method: "cash", amountReceivedYen: input.amountReceivedYen, changeYen },
      },
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  await closeLockedSession(tx, ctx, session);
  await revokeGuestSessionsForTableSession(tx, tableSessionId);
  await appendOutbox(tx, ctx.tenantId, ctx.locationId, {
    type: "checkout.completed",
    payload: {
      tableSessionId,
      tableId: session.tableId,
      paymentId: payment.id,
      receiptId: receipt.id,
    },
  });
  await recordAudit(tx, ctx, {
    action: "checkout.completed",
    targetType: "payment",
    targetId: payment.id,
    metadata: {
      tableSessionId,
      amountDueYen: bill.totalYen,
      amountReceivedYen: input.amountReceivedYen,
      changeYen,
      receiptNo,
    },
  });

  return {
    paymentId: payment.id,
    receiptId: receipt.id,
    receiptNo,
    amountDueYen: bill.totalYen,
    amountReceivedYen: input.amountReceivedYen,
    changeYen,
  };
}

/** Closes a session that has nothing billable (e.g. guests left before ordering). */
export async function closeEmptySession(
  tx: Tx,
  ctx: StaffContext,
  tableSessionId: string,
): Promise<void> {
  const session = await lockSession(tx, ctx.locationId, tableSessionId);
  const bill = await getBill(tx, ctx.locationId, tableSessionId);
  if (bill.lines.length > 0)
    throw Errors.conflict("unpaid_items", "The session has unpaid items; check out instead");
  await closeLockedSession(tx, ctx, session);
  await revokeGuestSessionsForTableSession(tx, tableSessionId);
  await recordAudit(tx, ctx, {
    action: "table_session.closed_empty",
    targetType: "table_session",
    targetId: tableSessionId,
  });
}

export async function getReceipt(tx: Tx, locationId: string, receiptId: string) {
  const r = await tx
    .selectFrom("receipts")
    .select(["id", "receipt_no", "issued_at", "body", "table_session_id", "payment_id"])
    .where("id", "=", receiptId)
    .where("location_id", "=", locationId)
    .executeTakeFirst();
  if (!r) throw Errors.notFound("receipt");
  return {
    id: r.id,
    receiptNo: r.receipt_no,
    issuedAt: r.issued_at,
    tableSessionId: r.table_session_id,
    paymentId: r.payment_id,
    body: r.body,
  };
}
