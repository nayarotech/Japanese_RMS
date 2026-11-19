# tenants

**Purpose:** Restaurant **organizations** (the tenant) and who belongs to them.

**Owns**

- Tenant records and lifecycle status (onboarding, active, suspended, closed).
- Tenant memberships (user to tenant, with tenant role) and location memberships (user to location subset).
- Assignment of a tenant to a brand (white-label partner brand).

**Does not own**

- Branch details (`restaurants`). Subscription state (`subscriptions`). Roles/permissions definitions (`authorization`).

**Notes:** Tenant status is operational (for example suspended for abuse). It is distinct from subscription status. Changes are platform-admin operations and are audited.
