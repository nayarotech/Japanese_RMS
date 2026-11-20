/**
 * authorization: what a staff member may do. Code checks PERMISSIONS, never role names.
 * Entitlements (what the subscription includes) are a separate check in modules/entitlements.
 */
import type { StaffRole } from "../../infrastructure/database/schema.js";
import { Errors } from "../../shared/errors/app-error.js";
import type { StaffContext } from "../../shared/types/access-context.js";

export const PERMISSIONS = [
  "tables.view",
  "tables.manage",
  "sessions.manage",
  "menu.view",
  "menu.manage",
  "orders.create",
  "orders.edit",
  "orders.void_prepared",
  "kitchen.view",
  "kitchen.update",
  "floor.view",
  "floor.serve",
  "checkout.perform",
  "receipts.view",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL: readonly Permission[] = PERMISSIONS;

export const ROLE_PERMISSIONS: Record<StaffRole, readonly Permission[]> = {
  owner: ALL,
  manager: ALL,
  cashier: [
    "tables.view",
    "sessions.manage",
    "menu.view",
    "orders.create",
    "orders.edit",
    "floor.view",
    "checkout.perform",
    "receipts.view",
  ],
  waiter: [
    "tables.view",
    "sessions.manage",
    "menu.view",
    "orders.create",
    "orders.edit",
    "floor.view",
    "floor.serve",
  ],
  kitchen: ["kitchen.view", "kitchen.update", "menu.view"],
};

export function permissionsFor(role: StaffRole): ReadonlySet<Permission> {
  return new Set(ROLE_PERMISSIONS[role]);
}

export function can(ctx: StaffContext, permission: Permission): boolean {
  return ctx.permissions.has(permission);
}

export function requirePermission(ctx: StaffContext, permission: Permission): void {
  if (!can(ctx, permission)) throw Errors.forbidden(permission);
}
