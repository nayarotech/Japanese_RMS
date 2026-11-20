/**
 * Socket.IO server: authenticated, origin-checked, server-assigned rooms, Redis adapter for multi-replica fan-out.
 * Clients send NO business events over the socket (writes go through HTTP use cases); the socket is a
 * notification channel only, which removes a whole class of client-originated event attacks.
 */
import type { Server as HttpServer } from "node:http";
import { createAdapter } from "@socket.io/redis-adapter";
import { parseCookie } from "cookie";
import type { Redis } from "ioredis";
import { Server, type Socket } from "socket.io";
import type { AppDeps } from "../../app/deps.js";
import { authenticateStaff } from "../../modules/identity/application/sessions.js";
import { authenticateGuest } from "../../modules/qr-ordering/index.js";
import type { GuestContext, StaffContext } from "../../shared/types/access-context.js";
import { cookieNames } from "../security/cookies.js";
import { rooms } from "./rooms.js";

const REVALIDATE_MS = 30_000;

export interface RealtimeControl {
  io: Server;
  disconnectStaffSession(sessionId: string): void;
}

export function createSocketServer(
  httpServer: HttpServer,
  deps: AppDeps,
  redis: { pub: Redis; sub: Redis },
): RealtimeControl {
  const { config } = deps;
  const names = cookieNames(config.COOKIE_SECURE);
  const io = new Server(httpServer, {
    path: config.SOCKET_IO_PATH,
    serveClient: false,
    cors: { origin: config.APP_PUBLIC_ORIGINS, credentials: true },
    // CORS does not cover WebSocket upgrades: check Origin explicitly (cross-site WebSocket hijacking).
    allowRequest: (req, cb) => {
      const origin = req.headers.origin;
      cb(null, origin === undefined || config.APP_PUBLIC_ORIGINS.includes(origin));
    },
    maxHttpBufferSize: 10_000,
  });
  io.adapter(createAdapter(redis.pub, redis.sub));

  io.use((socket, next) => {
    void (async () => {
      const cookies = parseCookie(socket.handshake.headers.cookie ?? "");
      const meta = { ip: socket.handshake.address || null, requestId: `ws-${socket.id}` };
      const staffToken = cookies[names.staff];
      const guestToken = cookies[names.guest];
      // Staff credential first; fall back to the guest credential (a stale staff cookie must not block a guest).
      const staffPrincipal = staffToken ? await authenticateStaff(deps, staffToken, meta) : null;
      const principal: StaffContext | GuestContext | null =
        staffPrincipal ?? (guestToken ? await authenticateGuest(deps.db, guestToken, meta) : null);
      if (!principal) {
        next(new Error("unauthenticated"));
        return;
      }
      (socket.data as { principal: StaffContext | GuestContext }).principal = principal;
      next();
    })().catch((err: unknown) => {
      deps.logger.error({ err }, "socket auth failed");
      next(new Error("unauthenticated"));
    });
  });

  io.on("connection", (socket) => {
    const principal = (socket.data as { principal: StaffContext | GuestContext }).principal;
    void socket.join(roomsFor(principal));
    socket.emit("session.ready", { kind: principal.kind });

    // Periodic re-validation: logout, membership removal, checkout or expiry ends the socket.
    const token = parseCookie(socket.handshake.headers.cookie ?? "")[
      principal.kind === "staff" ? names.staff : names.guest
    ];
    const timer = setInterval(() => {
      void revalidate(deps, socket, principal.kind, token).catch(() => socket.disconnect(true));
    }, REVALIDATE_MS);
    timer.unref();
    socket.on("disconnect", () => {
      clearInterval(timer);
    });
  });

  return {
    io,
    disconnectStaffSession: (sessionId) => {
      io.in(rooms.staffSession(sessionId)).disconnectSockets(true);
    },
  };
}

export function roomsFor(p: StaffContext | GuestContext): string[] {
  if (p.kind === "guest") return [rooms.guestTable(p.tenantId, p.tableSessionId)];
  const list = [rooms.user(p.tenantId, p.userId), rooms.staffSession(p.sessionId)];
  if (p.permissions.has("tables.view")) list.push(rooms.staff(p.tenantId, p.locationId));
  if (p.permissions.has("kitchen.view")) list.push(rooms.kitchen(p.tenantId, p.locationId));
  if (p.permissions.has("floor.serve")) list.push(rooms.floor(p.tenantId, p.locationId));
  return list;
}

async function revalidate(
  deps: AppDeps,
  socket: Socket,
  kind: "staff" | "guest",
  token: string | undefined,
): Promise<void> {
  const meta = { ip: null, requestId: `ws-${socket.id}` };
  const ok = token
    ? kind === "staff"
      ? await authenticateStaff(deps, token, meta)
      : await authenticateGuest(deps.db, token, meta)
    : null;
  if (!ok) socket.disconnect(true);
}
