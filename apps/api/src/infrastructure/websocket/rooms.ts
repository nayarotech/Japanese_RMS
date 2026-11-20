/**
 * Socket.IO room names. Every room is scoped by tenant id. Rooms are joined ONLY by the server
 * after authentication/authorization; clients cannot request arbitrary rooms.
 */
export const rooms = {
  /** Staff with tables.view at a location (POS, table map, checkout). */
  staff: (tenantId: string, locationId: string) => `t:${tenantId}:l:${locationId}:staff`,
  /** Kitchen staff (kitchen.view). */
  kitchen: (tenantId: string, locationId: string) => `t:${tenantId}:l:${locationId}:kitchen`,
  /** Floor staff who can serve (floor.serve): fallback recipients for food-ready alerts. */
  floor: (tenantId: string, locationId: string) => `t:${tenantId}:l:${locationId}:floor`,
  /** A single staff user (assigned-waiter notifications). */
  user: (tenantId: string, userId: string) => `t:${tenantId}:u:${userId}`,
  /** All sockets of one staff session (for immediate disconnect on logout/revocation). */
  staffSession: (sessionId: string) => `ss:${sessionId}`,
  /** Guests joined to one dining session. Receives id-only "refresh" hints. */
  guestTable: (tenantId: string, tableSessionId: string) =>
    `t:${tenantId}:ts:${tableSessionId}:guest`,
};
