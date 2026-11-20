/**
 * Browser API client. Same-origin `/api/v1` (cookies are HttpOnly; JS never sees session tokens).
 * Mutations carry the CSRF token (kept in memory only) and, where required, an Idempotency-Key.
 */
import type { ApiErrorBody } from "@restaurant-platform/contracts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface ApiClient {
  setCsrf(token: string | null): void;
  get<T>(path: string): Promise<T>;
  send<T>(
    method: "POST" | "PATCH" | "PUT",
    path: string,
    body?: unknown,
    opts?: { idempotencyKey?: string },
  ): Promise<T>;
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function createApiClient(): ApiClient {
  let csrf: string | null = null;

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (method !== "GET" && csrf) headers["X-CSRF-Token"] = csrf;
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    let res: Response;
    try {
      res = await fetch(`/api/v1${path}`, {
        method,
        headers,
        credentials: "same-origin",
        cache: "no-store",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ApiError(0, "network_error", "Network error");
    }
    if (res.status === 204) return undefined as T;
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const err = (json as ApiErrorBody | null)?.error;
      throw new ApiError(
        res.status,
        err?.code ?? "http_error",
        err?.message ?? res.statusText,
        err?.details,
      );
    }
    return json as T;
  }

  return {
    setCsrf: (t) => {
      csrf = t;
    },
    get: (path) => request("GET", path),
    send: (method, path, body, opts) => request(method, path, body ?? {}, opts?.idempotencyKey),
  };
}

/** Maps an error to an i18n key under `errors.*` (or a feature-specific key when provided). */
export function errorKey(err: unknown): string {
  if (!(err instanceof ApiError)) return "errors.generic";
  if (err.status === 0) return "errors.network";
  if (err.code === "feature_not_entitled") return "errors.notEntitled";
  if (err.status === 403) return "errors.forbidden";
  if (err.status === 404) return "errors.notFound";
  if (err.code === "version_conflict" || err.code === "concurrent_update") return "errors.conflict";
  return "errors.generic";
}

export const staffApi = createApiClient();
export const guestApi = createApiClient();
