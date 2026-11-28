/**
 * "Your recent order" shortcut on the storefront: per-viewer browser convenience only (the tracking link itself is the
 * credential). Storage may be unavailable (private mode); every access is wrapped in try/catch.
 */
const KEY = "rp_online_recent";

export function saveRecentOrder(
  storeToken: string,
  value: { token: string; orderNo: number },
): void {
  try {
    localStorage.setItem(`${KEY}:${storeToken}`, JSON.stringify(value));
  } catch {
    /* the status link still works from the URL */
  }
}

export function loadRecentOrder(storeToken: string): { token: string; orderNo: number } | null {
  try {
    const raw = localStorage.getItem(`${KEY}:${storeToken}`);
    return raw ? (JSON.parse(raw) as { token: string; orderNo: number }) : null;
  } catch {
    return null;
  }
}

/**
 * Marks an order as "just placed" in this tab, so the status page opens as a confirmation and can link back to the
 * storefront it came from. Tab-scoped (sessionStorage); the tracking link alone still works anywhere.
 */
const PLACED = "rp_online_placed";
export interface JustPlaced {
  trackingToken: string;
  storeToken: string;
  orderNo: number;
}
export function markJustPlaced(v: JustPlaced): void {
  try {
    sessionStorage.setItem(PLACED, JSON.stringify(v));
  } catch {
    /* optional */
  }
}
export function readJustPlaced(trackingToken: string): JustPlaced | null {
  try {
    const raw = sessionStorage.getItem(PLACED);
    const v = raw ? (JSON.parse(raw) as JustPlaced) : null;
    return v && v.trackingToken === trackingToken && /^[A-Za-z0-9_-]{22,64}$/.test(v.storeToken)
      ? v
      : null;
  } catch {
    return null;
  }
}

/**
 * The idempotency key of an order submission that may or may not have reached the server (lost response, closed tab).
 * Reused for the SAME request, so retrying returns the original order instead of creating a second one.
 */
const PENDING = "rp_online_pending";
export function submissionKey(storeToken: string, signature: string, fresh: () => string): string {
  try {
    const raw = sessionStorage.getItem(`${PENDING}:${storeToken}`);
    const v = raw ? (JSON.parse(raw) as { key?: string; sig?: string; at?: number }) : null;
    if (v?.key && v.sig === signature && typeof v.at === "number" && Date.now() - v.at < 3600_000)
      return v.key;
    const key = fresh();
    sessionStorage.setItem(
      `${PENDING}:${storeToken}`,
      JSON.stringify({ key, sig: signature, at: Date.now() }),
    );
    return key;
  } catch {
    return fresh();
  }
}
export function clearSubmissionKey(storeToken: string): void {
  try {
    sessionStorage.removeItem(`${PENDING}:${storeToken}`);
  } catch {
    /* optional */
  }
}
