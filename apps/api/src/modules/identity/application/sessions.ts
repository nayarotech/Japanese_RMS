/**
 * Staff authentication: Argon2id passwords, server-side revocable sessions (only token hashes stored),
 * idle + absolute expiry, lockout after repeated failures.
 */
import { sql } from "kysely";
import type { AppDeps } from "../../../app/deps.js";
import { withTenantTransaction, withUserTransaction } from "../../../infrastructure/database/db.js";
import type { StaffRole } from "../../../infrastructure/database/schema.js";
import { newSessionToken, sha256 } from "../../../infrastructure/security/tokens.js";
import { AppError } from "../../../shared/errors/app-error.js";
import type { StaffContext } from "../../../shared/types/access-context.js";
import { recordAudit } from "../../audit/index.js";
import { permissionsFor } from "../../authorization/index.js";
import { hashPassword, verifyDummy, verifyPassword } from "./passwords.js";

const MAX_FAILED_LOGINS = 10;
const LOCKOUT_MINUTES = 15;
const TOUCH_INTERVAL_MS = 60_000;

const invalidCredentials = () =>
  new AppError(401, "invalid_credentials", "Invalid email or password");

export interface LoginInput {
  email: string;
  password: string;
  locationId?: string | undefined;
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

export interface LoginResult {
  token: string;
  context: StaffContext;
  absoluteExpiresAt: Date;
}

export async function login(deps: AppDeps, input: LoginInput): Promise<LoginResult> {
  const { db, config } = deps;
  const user = await db
    .selectFrom("users")
    .selectAll()
    .where(sql`lower(email)`, "=", input.email.toLowerCase())
    .executeTakeFirst();

  if (!user) {
    await verifyDummy(input.password);
    throw invalidCredentials();
  }
  const locked = user.locked_until !== null && user.locked_until > new Date();
  const passwordOk = await verifyPassword(user.password_hash, input.password);
  if (locked || user.status !== "active" || !passwordOk) {
    if (!passwordOk && !locked) {
      const failed = user.failed_login_count + 1;
      await db
        .updateTable("users")
        .set({
          failed_login_count: failed >= MAX_FAILED_LOGINS ? 0 : failed,
          locked_until:
            failed >= MAX_FAILED_LOGINS
              ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000)
              : user.locked_until,
        })
        .where("id", "=", user.id)
        .execute();
    }
    deps.logger.warn({ userId: user.id, locked, requestId: input.requestId }, "login failed");
    throw invalidCredentials();
  }

  const memberships = await withUserTransaction(db, user.id, (tx) =>
    tx
      .selectFrom("location_memberships")
      .select(["tenant_id", "location_id", "role"])
      .where("user_id", "=", user.id)
      .execute(),
  );
  const membership = input.locationId
    ? memberships.find((m) => m.location_id === input.locationId)
    : memberships.length === 1
      ? memberships[0]
      : memberships.sort((a, b) => a.location_id.localeCompare(b.location_id))[0];
  if (!membership) throw new AppError(403, "no_location_access", "No access to this location");

  const token = newSessionToken();
  const now = Date.now();
  const idleExpiresAt = new Date(now + config.SESSION_IDLE_TIMEOUT_MINUTES * 60_000);
  const absoluteExpiresAt = new Date(now + config.SESSION_ABSOLUTE_TIMEOUT_HOURS * 3_600_000);

  const context = await withTenantTransaction(
    db,
    { tenantId: membership.tenant_id },
    async (tx) => {
      const tenant = await tx
        .selectFrom("tenants")
        .select("status")
        .where("id", "=", membership.tenant_id)
        .executeTakeFirst();
      if (tenant?.status !== "active")
        throw new AppError(403, "tenant_inactive", "This restaurant account is not active");

      await tx
        .updateTable("users")
        .set({ failed_login_count: 0, locked_until: null })
        .where("id", "=", user.id)
        .execute();
      const session = await tx
        .insertInto("staff_sessions")
        .values({
          token_hash: sha256(token),
          user_id: user.id,
          tenant_id: membership.tenant_id,
          location_id: membership.location_id,
          last_seen_at: new Date(now),
          idle_expires_at: idleExpiresAt,
          absolute_expires_at: absoluteExpiresAt,
          ip: input.ip,
          user_agent: input.userAgent?.slice(0, 300) ?? null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const ctx = buildContext(
        session.id,
        user.id,
        user.display_name,
        membership.tenant_id,
        membership.location_id,
        membership.role,
        input,
      );
      await recordAudit(tx, ctx, { action: "auth.login", targetType: "user", targetId: user.id });
      return ctx;
    },
  );
  return { token, context, absoluteExpiresAt };
}

/** Resolves a session cookie into a StaffContext, or null if missing/expired/revoked. */
export async function authenticateStaff(
  deps: AppDeps,
  token: string,
  meta: { ip: string | null; requestId: string },
): Promise<StaffContext | null> {
  const { db, config } = deps;
  const now = new Date();
  const session = await db
    .selectFrom("staff_sessions as s")
    .innerJoin("users as u", "u.id", "s.user_id")
    .select([
      "s.id",
      "s.user_id",
      "s.tenant_id",
      "s.location_id",
      "s.last_seen_at",
      "u.display_name",
      "u.status",
    ])
    .where("s.token_hash", "=", sha256(token))
    .where("s.revoked_at", "is", null)
    .where("s.idle_expires_at", ">", now)
    .where("s.absolute_expires_at", ">", now)
    .executeTakeFirst();
  if (!session || session.status !== "active") return null;

  // Role is read on every request so role changes and membership removal apply immediately.
  const role = await withTenantTransaction(db, { tenantId: session.tenant_id }, async (tx) => {
    const m = await tx
      .selectFrom("location_memberships")
      .select("role")
      .where("location_id", "=", session.location_id)
      .where("user_id", "=", session.user_id)
      .executeTakeFirst();
    return m?.role ?? null;
  });
  if (!role) return null;

  if (now.getTime() - session.last_seen_at.getTime() > TOUCH_INTERVAL_MS) {
    await db
      .updateTable("staff_sessions")
      .set({
        last_seen_at: now,
        idle_expires_at: new Date(now.getTime() + config.SESSION_IDLE_TIMEOUT_MINUTES * 60_000),
      })
      .where("id", "=", session.id)
      .execute();
  }
  return buildContext(
    session.id,
    session.user_id,
    session.display_name,
    session.tenant_id,
    session.location_id,
    role,
    meta,
  );
}

export async function logout(deps: AppDeps, ctx: StaffContext): Promise<void> {
  await withTenantTransaction(deps.db, { tenantId: ctx.tenantId }, async (tx) => {
    await tx
      .updateTable("staff_sessions")
      .set({ revoked_at: new Date() })
      .where("id", "=", ctx.sessionId)
      .execute();
    await recordAudit(tx, ctx, { action: "auth.logout", targetType: "user", targetId: ctx.userId });
  });
}

function buildContext(
  sessionId: string,
  userId: string,
  displayName: string,
  tenantId: string,
  locationId: string,
  role: StaffRole,
  meta: { ip: string | null; requestId: string },
): StaffContext {
  return {
    kind: "staff",
    sessionId,
    userId,
    displayName,
    tenantId,
    locationId,
    role,
    permissions: permissionsFor(role),
    requestId: meta.requestId,
    ip: meta.ip,
  };
}

export { hashPassword };
