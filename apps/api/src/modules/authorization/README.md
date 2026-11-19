# authorization

**Purpose:** Decide _whether_ an authenticated principal may perform an action on a resource.

**Owns**

- Permission catalog (stable string keys, e.g. `orders.void`, `menus.edit`, `platform.plans.manage`).
- Roles as named permission sets, at two separate scopes: **platform** roles and **tenant** roles (optionally narrowed to locations).
- Building the per-request `AccessContext` (principal, tenant, allowed locations, permissions, assurance level such as MFA).
- Policy checks: `authorize(ctx, permission, resource)`.

**Does not own**

- Subscription features (`entitlements`). A request must pass **both** checks.
- Authentication (`identity`).

**Invariants**

- Tenant identity in `AccessContext` comes from the authenticated membership, never from a client-supplied ID.
- Platform permissions are never granted through tenant roles, and vice versa.
- Tenant admins cannot grant permissions that manage subscriptions or entitlements (those do not exist at tenant scope).
