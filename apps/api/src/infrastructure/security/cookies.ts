import type { CookieOptions } from "express";

export interface CookieNames {
  staff: string;
  guest: string;
}

/** `__Host-` prefix requires Secure; plain-HTTP localhost development uses unprefixed names. */
export function cookieNames(secure: boolean): CookieNames {
  return secure
    ? { staff: "__Host-rp_sid", guest: "__Host-rp_gsid" }
    : { staff: "rp_sid", guest: "rp_gsid" };
}

export function sessionCookieOptions(secure: boolean, maxAgeMs: number): CookieOptions {
  return { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: maxAgeMs };
}
