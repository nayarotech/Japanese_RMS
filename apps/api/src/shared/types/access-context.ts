import type { StaffRole } from "../../infrastructure/database/schema.js";

/** Built server-side from an authenticated staff session. Never from client-supplied IDs. */
export interface StaffContext {
  kind: "staff";
  sessionId: string;
  userId: string;
  displayName: string;
  tenantId: string;
  locationId: string;
  role: StaffRole;
  permissions: ReadonlySet<string>;
  requestId: string;
  ip: string | null;
}

/** Built server-side from a guest (QR) session cookie. Bound to exactly one table session. */
export interface GuestContext {
  kind: "guest";
  guestSessionId: string;
  tenantId: string;
  locationId: string;
  tableSessionId: string;
  requestId: string;
  ip: string | null;
}

/**
 * An anonymous online-ordering customer (no account). Before submission it is identified by nothing; afterwards only
 * by a revocable, expiring order-tracking token that is scoped to exactly ONE online order.
 */
export interface CustomerContext {
  kind: "customer";
  tenantId: string;
  locationId: string;
  onlineOrderId: string | null;
  trackingTokenId: string | null;
  requestId: string;
  ip: string | null;
}
