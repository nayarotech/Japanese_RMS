/** Database role names used in GRANT/POLICY statements. Validated to prevent SQL injection via env. */
const ROLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;

function role(envName: string, fallback: string): string {
  const value = process.env[envName] ?? fallback;
  if (!ROLE_RE.test(value)) throw new Error(`${envName} is not a valid role name`);
  return value;
}

export function roleNames(): { app: string; relay: string } {
  return {
    app: role("DATABASE_APP_USER", "rp_app"),
    relay: role("DATABASE_RELAY_USER", "rp_relay"),
  };
}
