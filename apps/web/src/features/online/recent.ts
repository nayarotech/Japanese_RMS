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
