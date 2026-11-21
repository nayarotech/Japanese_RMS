/**
 * online-orders: online ordering with pickup and delivery (Standard package and above).
 *
 * Reuses the existing order domain (orders/order_items with ONLINE_* sources, menu prices, idempotency, kitchen
 * tickets, payments, outbox, audit). Owns only what differs: storefront link, ordering settings/hours, delivery
 * area and fees, the fulfilment record, customer contact data and tracking credentials.
 * See docs/architecture/15-online-ordering.md.
 */
export { onlineOrderPublicRoutes } from "./http/public-routes.js";
export { onlineOrderStaffRoutes } from "./http/staff-routes.js";
export { syncOnlineOrderFromKitchen } from "./application/manage.js";
export { authenticateTrackingToken, revokeTrackingTokens } from "./application/tracking.js";
