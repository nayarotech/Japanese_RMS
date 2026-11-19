# identity

**Purpose:** Establish _who_ is making a request.

**Owns**

- User accounts (platform operators, restaurant staff with logins) and credentials (password hashes via an established library; see ADR-0006).
- Server-side, revocable sessions (idle + absolute timeout, rotation on login and privilege change).
- MFA enrolment and verification (mandatory for platform operators and tenant owners).
- Account recovery, login rate limiting and lockout signals.
- POS **device sessions**: a registered terminal bound to one location, revocable by managers.

**Does not own**

- Permissions or roles (`authorization`). Staff profile data (`staff`). Tenant membership (`tenants`).

**Exposes (planned):** `authenticate(request) -> Principal | null`, session revoke/rotate, MFA step-up.

**Notes:** Use an established library. No custom crypto, no custom token formats. Customers ordering via QR or online are **not** identity users unless an account feature is approved later.
