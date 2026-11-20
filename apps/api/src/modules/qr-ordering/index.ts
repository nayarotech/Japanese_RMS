/**
 * qr-ordering: the public, customer-facing dine-in flow (scan -> menu -> join -> order -> status).
 * Exposes only public data. Never staff, financial-report or other-table data.
 */
import type { AppDeps } from "../../app/deps.js";
import { withTenantTransaction } from "../../infrastructure/database/db.js";
import { withIdempotency } from "../../infrastructure/database/idempotency.js";
import { Errors } from "../../shared/errors/app-error.js";
import type { GuestContext } from "../../shared/types/access-context.js";
import { recordAudit } from "../audit/index.js";
import { getTenantBrand } from "../branding/index.js";
import { hasFeature, requireFeature } from "../entitlements/index.js";
import { getMenu } from "../menus/index.js";
import { type OrderLineInput, listSessionOrders, placeOrder } from "../orders/index.js";
import { getLocationSettings } from "../restaurants/index.js";
import {
  findActiveSessionForTable,
  getTableName,
  resolveQrToken,
  openSessionFromQr,
} from "../tables/index.js";
import { createGuestSession } from "./sessions.js";

export { authenticateGuest, revokeGuestSessionsForTableSession } from "./sessions.js";

export async function getPublicTable(deps: AppDeps, token: string, guest: GuestContext | null) {
  const ref = await resolveQrToken(deps.db, token);
  if (!ref) throw Errors.notFound("table");
  return withTenantTransaction(deps.db, { tenantId: ref.tenantId }, async (tx) => {
    const [location, brand, tableName, active, entitled] = await Promise.all([
      getLocationSettings(tx, ref.locationId),
      getTenantBrand(tx, ref.tenantId),
      getTableName(tx, ref.tableId),
      findActiveSessionForTable(tx, ref.tableId),
      hasFeature(tx, ref.locationId, "table_qr_ordering"),
    ]);
    const menu = await getMenu(tx, ref.locationId, { publicView: true });
    const joined = guest !== null && active !== null && guest.tableSessionId === active.id;
    return {
      brand,
      location: { name: location.name },
      table: { name: tableName },
      orderingEnabled: entitled && location.qrOrderingEnabled,
      sessionState: active ? active.status : "none",
      joined,
      menu: menu.map((c) => ({
        id: c.id,
        name: c.name,
        items: c.items.map((i) => ({
          id: i.id,
          name: i.name,
          description: i.description,
          priceYen: i.priceYen,
          isAvailable: i.isAvailable,
        })),
      })),
    };
  });
}

/**
 * Scan-to-order: scanning a table's QR gives a guest credential bound to THAT table's current dining
 * session, opening one if the table is free (no code, no staff step; ADR-0008). Ends at checkout.
 */
export async function joinTable(
  deps: AppDeps,
  token: string,
  meta: { ip: string | null; requestId: string },
) {
  const ref = await resolveQrToken(deps.db, token);
  if (!ref) throw Errors.notFound("table");
  return withTenantTransaction(deps.db, { tenantId: ref.tenantId }, async (tx) => {
    await requireFeature(tx, ref.locationId, "table_qr_ordering");
    const location = await getLocationSettings(tx, ref.locationId);
    if (!location.qrOrderingEnabled) throw Errors.forbidden();
    // Whoever sits at this table may order: join its current session, or open one on first scan.
    const current = await findActiveSessionForTable(tx, ref.tableId);
    if (current?.status === "bill_requested") {
      throw Errors.conflict(
        "session_checkout_in_progress",
        "The bill has been requested for this table.",
      );
    }
    const session = current ?? (await openSessionFromQr(tx, ref));
    const guest = await createGuestSession(tx, {
      tenantId: ref.tenantId,
      locationId: ref.locationId,
      tableSessionId: session.id,
      ip: meta.ip,
    });
    await recordAudit(
      tx,
      {
        kind: "guest",
        guestSessionId: guest.guestSessionId,
        tenantId: ref.tenantId,
        locationId: ref.locationId,
        tableSessionId: session.id,
        ...meta,
      },
      { action: "guest.joined", targetType: "table_session", targetId: session.id },
    );
    return guest;
  });
}

export async function getGuestSessionView(deps: AppDeps, guest: GuestContext) {
  return withTenantTransaction(deps.db, guest, async (tx) => {
    const s = await tx
      .selectFrom("table_sessions as s")
      .innerJoin("restaurant_tables as t", "t.id", "s.table_id")
      .select(["s.status", "t.name"])
      .where("s.id", "=", guest.tableSessionId)
      .executeTakeFirstOrThrow();
    const orders = await listSessionOrders(tx, guest.tableSessionId);
    return {
      table: { name: s.name },
      sessionStatus: s.status,
      orders: orders.map((o) => ({
        id: o.id,
        orderNo: o.orderNo,
        source: o.source,
        createdAt: o.createdAt,
        items: o.items
          .filter((i) => i.status === "active")
          .map((i) => ({
            id: i.id,
            nameJa: i.nameJa,
            nameEn: i.nameEn,
            quantity: i.quantity,
            note: i.note,
            unitPriceYen: i.unitPriceYen,
            kitchenStatus: i.kitchenStatus,
          })),
      })),
    };
  });
}

export async function placeGuestOrder(
  deps: AppDeps,
  guest: GuestContext,
  idempotencyKey: string,
  items: OrderLineInput[],
) {
  return withTenantTransaction(deps.db, guest, async (tx) => {
    await requireFeature(tx, guest.locationId, "table_qr_ordering");
    const location = await getLocationSettings(tx, guest.locationId);
    if (!location.qrOrderingEnabled) throw Errors.forbidden();
    return withIdempotency(
      tx,
      {
        tenantId: guest.tenantId,
        scope: `guest-order:${guest.guestSessionId}`,
        key: idempotencyKey,
        request: items,
      },
      async () => ({ status: 201, body: await placeOrder(tx, guest, guest.tableSessionId, items) }),
    );
  });
}
