import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** 256-bit random token, base64url. Used for session cookies (only the hash is stored). */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** 128-bit random token for printed table QR codes (22 base64url chars). */
export function newQrToken(): string {
  return randomBytes(16).toString("base64url");
}

export function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** CSRF token bound to a session id: HMAC(secret, sessionId). Unforgeable without the server secret. */
export function csrfTokenFor(secret: string, sessionId: string): string {
  return createHmac("sha256", secret).update(`csrf:${sessionId}`).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Stable hash of a request body for idempotency-key reuse detection. */
export function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
