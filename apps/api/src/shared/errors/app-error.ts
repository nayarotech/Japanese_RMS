/**
 * Application error model. Every expected failure is an AppError with a stable machine `code`
 * (translated by clients) and an HTTP status. Unexpected errors become 500 without details.
 */
export class AppError extends Error {
  override name = "AppError";
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code);
  }
}

export const Errors = {
  validation: (details?: Record<string, unknown>) =>
    new AppError(400, "validation_failed", "Invalid request", details),
  unauthenticated: () => new AppError(401, "unauthenticated", "Authentication required"),
  csrf: () => new AppError(403, "csrf_failed", "Missing or invalid CSRF token"),
  forbidden: (permission?: string) =>
    new AppError(403, "forbidden", "Not allowed", permission ? { permission } : undefined),
  notEntitled: (feature: string) =>
    new AppError(403, "feature_not_entitled", "Feature not included in plan", { feature }),
  notFound: (what = "resource") => new AppError(404, "not_found", `${what} not found`),
  conflict: (code: string, message?: string, details?: Record<string, unknown>) =>
    new AppError(409, code, message, details),
  unprocessable: (code: string, message?: string, details?: Record<string, unknown>) =>
    new AppError(422, code, message, details),
  rateLimited: (retryAfterSeconds: number) =>
    new AppError(429, "rate_limited", "Too many requests", { retryAfterSeconds }),
};
