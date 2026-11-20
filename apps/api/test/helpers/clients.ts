/** HTTP clients that behave like the browser apps: cookies, CSRF header, Origin header, idempotency keys. */
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { Harness } from "./harness.js";
import { ORIGIN } from "./harness.js";

type App = Harness["app"];

export interface StaffClient {
  cookie: string;
  csrf: string;
  me: { user: { id: string }; role: string; location: { id: string } };
  get(path: string): request.Test;
  post(path: string, body?: object, headers?: Record<string, string>): request.Test;
  patch(path: string, body?: object): request.Test;
  put(path: string, body?: object): request.Test;
}

function cookieFrom(res: request.Response): string {
  const set = res.headers["set-cookie"] as unknown as string[] | undefined;
  const c = set?.[0]?.split(";")[0];
  if (!c) throw new Error(`no cookie set (status ${res.status}): ${JSON.stringify(res.body)}`);
  return c;
}

export async function loginStaff(app: App, email: string, password: string): Promise<StaffClient> {
  const res = await request(app)
    .post("/api/v1/auth/login")
    .set("Origin", ORIGIN)
    .send({ email, password });
  if (res.status !== 200)
    throw new Error(`login failed ${res.status}: ${JSON.stringify(res.body)}`);
  const cookie = cookieFrom(res);
  const csrf = (res.body as { csrfToken: string }).csrfToken;
  const withAuth = (t: request.Test) =>
    t.set("Cookie", cookie).set("Origin", ORIGIN).set("X-CSRF-Token", csrf);
  return {
    cookie,
    csrf,
    me: res.body as StaffClient["me"],
    get: (p) => request(app).get(`/api/v1${p}`).set("Cookie", cookie),
    post: (p, body = {}, headers = {}) =>
      withAuth(request(app).post(`/api/v1${p}`))
        .set(headers)
        .send(body),
    patch: (p, body = {}) => withAuth(request(app).patch(`/api/v1${p}`)).send(body),
    put: (p, body = {}) => withAuth(request(app).put(`/api/v1${p}`)).send(body),
  };
}

export interface GuestClient {
  cookie: string;
  csrf: string;
  session(): request.Test;
  order(
    items: { menuItemId: string; quantity: number; note?: string | null }[],
    key?: string,
  ): request.Test;
}

export async function joinAsGuest(app: App, qrToken: string): Promise<GuestClient> {
  const res = await request(app)
    .post(`/api/v1/public/tables/${qrToken}/join`)
    .set("Origin", ORIGIN)
    .send({});
  if (res.status !== 200) throw new Error(`join failed ${res.status}: ${JSON.stringify(res.body)}`);
  const cookie = cookieFrom(res);
  const csrf = (res.body as { csrfToken: string }).csrfToken;
  return {
    cookie,
    csrf,
    session: () => request(app).get("/api/v1/public/session").set("Cookie", cookie),
    order: (items, key = randomUUID()) =>
      request(app)
        .post("/api/v1/public/session/orders")
        .set("Cookie", cookie)
        .set("Origin", ORIGIN)
        .set("X-CSRF-Token", csrf)
        .set("Idempotency-Key", key)
        .send({ items }),
  };
}

export const idem = () => ({ "Idempotency-Key": randomUUID() });
