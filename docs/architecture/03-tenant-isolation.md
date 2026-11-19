# C. Tenant isolation

## Tenancy model

```
Platform (one installation)
 └─ Brand (white-label partner brand; usually one, possibly several)
     └─ Tenant (restaurant organization)            <- data isolation boundary
         ├─ Tenant memberships (user + tenant role)
         └─ Location (branch)                       <- operational boundary
             ├─ Location memberships (user limited to some locations)
             ├─ Subscription (see 04, ownership open decision)
             ├─ POS devices, tables, menus, orders, payments, business day
```

| Concept              | Definition                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Platform user        | Partner operator or dev-team support with **platform roles**. Not a member of any tenant by default.                                |
| Tenant user          | Owner, manager or staff with a **tenant membership**; optionally restricted to listed locations.                                    |
| Tenant membership    | `(user_id, tenant_id, tenant_role)`. A user may belong to several tenants (for example consultants); one active tenant per session. |
| Location membership  | `(user_id, tenant_id, location_id, location_role?)`. Absence = all locations if the tenant role allows it.                          |
| Customer (QR/online) | Anonymous, scoped to one table session or one online order token. Never a tenant member.                                            |

## The access context

Every request and job builds an `AccessContext` **server-side**:

```ts
type AccessContext = {
  principal: { kind: "platform_user" | "tenant_user" | "pos_device" | "customer"; id: string };
  tenantId: TenantId | null; // from the session's active membership, never from the URL/body
  locationIds: LocationId[] | "all";
  permissions: ReadonlySet<PermissionKey>;
  assurance: { mfa: boolean; reauthenticatedAt?: Date };
  supportGrant?: { grantId: string; actorId: string; readOnly: boolean; expiresAt: Date };
  requestId: string;
};
```

A `locationId` in a URL is only a **selector**. The server checks it belongs to `ctx.tenantId` and is in
`ctx.locationIds`, and returns 404 otherwise (not 403, to avoid confirming existence across tenants).

## Defence in depth: four layers

| #   | Layer                     | Mechanism                                                                                   | Catches                                          |
| --- | ------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | Application authorization | `AccessContext` + `authorize()` in every use case                                           | Wrong user, wrong role, wrong location           |
| 2   | Query scoping             | Repositories always filter by `tenant_id` (and `location_id`) taken from the context        | Ordinary bugs                                    |
| 3   | **PostgreSQL RLS**        | Policies on every tenant-owned table compare `tenant_id` to a **transaction-local** setting | Forgotten `WHERE`, injection, reporting mistakes |
| 4   | Composite constraints     | FKs include `tenant_id`, so a row can only reference rows of the same tenant                | Cross-tenant references from bad input           |

### RLS design

- Every tenant-owned table has `tenant_id uuid NOT NULL` with `ENABLE` **and** `FORCE ROW LEVEL SECURITY`.
- Runtime connects as `rp_app` (no `BYPASSRLS`, not table owner). Migrations run as `rp_migrator`.
- Each unit of work runs in a transaction that first executes
  `SELECT set_config('app.tenant_id', $1, true)` (the `true` makes it **transaction-local**, so a pooled
  connection can never leak context into the next request).
- Policy shape: `USING (tenant_id = current_setting('app.tenant_id', true)::uuid)` with the same `WITH CHECK`.
  If the setting is absent, the expression is `NULL` and **no rows match (fail closed)**.
- The only way module code obtains a tenant-scoped Kysely handle is `withTenantTransaction(ctx, fn)`.
  A lint rule or code review blocks raw pool access outside `infrastructure/database`.
- **Platform-wide operations** (for example plan management, cross-tenant monitoring) use a separate,
  explicitly named path: either platform-owned tables without tenant RLS, or a dedicated DB role with
  narrowly scoped policies. Each such use case is audited. Platform users do not "become" a tenant except
  through a time-boxed **support grant** (see security architecture).
- Global reference data (feature registry mirror, plan catalog) lives in platform tables, readable by `rp_app`, writable only through platform-admin use cases.

### Composite keys pattern

```sql
-- parent exposes (tenant_id, id) as a unique key
ALTER TABLE locations ADD UNIQUE (tenant_id, id);
-- child references parent within the same tenant
FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id)
```

Operational tables carry both `tenant_id` and `location_id`. Leading indexes with `tenant_id` (or
`(tenant_id, location_id, …)`) make RLS predicates and common queries cheap.

## Other surfaces

| Surface        | Isolation rule                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| WebSocket      | Server joins sockets to rooms `t:{tenantId}` / `t:{tenantId}:l:{locationId}` after authorization. Clients cannot pick rooms.        |
| Jobs / outbox  | Every row stores `tenant_id`. The worker opens `withTenantTransaction` from that stored value.                                      |
| Exports        | Generated under the tenant context; stored under a tenant-prefixed key; delivered via short-lived signed URL to an authorized user. |
| Caches (Redis) | Keys always include tenant (and location) ids: `ent:{tenantId}:{locationId}:v{n}`. Never cache across tenants under shared keys.    |
| Logs           | Include `tenantId` for tracing; never include other tenants' data in error messages.                                                |
| Object storage | Keys prefixed `tenants/{tenantId}/…`; bucket private; uploads via signed URLs with size and type limits.                            |

## Verification (required once implementation begins)

Automated **cross-tenant test suite** (see 12-testing-strategy.md): for every route, socket event, job type
and export, a fixture with tenants A and B asserts that an A principal cannot read, list, modify or
reference any B resource, and that queries without tenant context return zero rows. This suite gates merges.
