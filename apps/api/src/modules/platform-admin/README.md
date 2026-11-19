# platform-admin

**Purpose:** Workflows for the Japanese partner's platform operators that span many tenants.

**Owns**

- Restaurant onboarding workflow (create tenant, first location, owner invitation, initial plan) by orchestrating other modules.
- **Support access grants**: time-boxed, reason-required, scope-limited (read-only by default) access to a tenant. No unrestricted impersonation.
- **High-impact change confirmation** (for example bulk plan changes, brand changes): preview, explicit confirmation, optional second approver.
- Cross-tenant operational views (tenant status, subscription overview) via other modules' services.

**Does not own**

- Plans (`subscriptions`), brands (`branding`), tenants (`tenants`). It orchestrates them.

**Security:** Requires platform roles, MFA, recent re-authentication for destructive or high-impact actions, and full audit. Separate route prefix (`/api/v1/platform/...`).
