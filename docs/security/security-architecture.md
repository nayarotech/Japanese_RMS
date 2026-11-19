# H. Security architecture

**Target:** OWASP ASVS 5.0 Level 2 as the minimum, with stronger controls for financial operations,
multi-tenant isolation and platform administration. No system is absolutely secure. These controls reduce
the attack surface and are verifiable by tests. **None of them are implemented or verified yet.**

## Trust boundaries

```
[Untrusted]  Browsers, POS devices, customer phones, partner webhooks, third-party APIs
     │  TLS, WAF, rate limits, input validation (Zod), authN
     ▼
[Edge]       CDN/WAF → Load balancer (TLS termination, sticky cookie)
     ▼
[App tier]   web (no secrets beyond what SSR needs, no DB)   api (all authZ / entitlement / tenant decisions)
     │  private network only, TLS to data stores, least-privilege DB role, RLS
     ▼
[Data tier]  PostgreSQL · Redis · Object storage · Secret manager   (no public endpoints)
     ▲
[Worker]     private, same DB role and RLS rules, outbound-only to external services
```

Rules: nothing from the untrusted side decides tenant identity, prices, totals, permissions or entitlements.
The frontend is untrusted presentation. Every decision is re-made server-side.

## Authentication

| Control               | Design                                                                                                                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Library               | Established library (ADR-0006). No custom protocol, token format or crypto.                                                                                                                                            |
| Sessions              | Server-side, revocable, opaque random ID in an `HttpOnly; Secure; SameSite=Lax; Path=/` host-only cookie (`__Host-` prefix). Idle timeout plus absolute timeout. Rotated on login, privilege change and MFA step-up.   |
| Passwords             | Argon2id (library defaults or stronger). Minimum length 12+, breached-password check (k-anonymity API) if approved, no composition rules.                                                                              |
| MFA                   | **Required** for platform users and tenant owners. Optional (policy-configurable) for managers. TOTP first; WebAuthn/passkeys recommended. Recovery codes hashed.                                                      |
| Step-up / re-auth     | Required for high-impact actions: refunds above a threshold, role changes, plan changes, brand changes, data exports, support grants.                                                                                  |
| Login protection      | Redis-backed rate limits per IP + per account, progressive delays, generic error messages (no account enumeration), alerting on spikes.                                                                                |
| Account recovery      | Single-use, short-lived, hashed tokens. Notification to the account on any recovery or credential change. Platform accounts recover only through a verified out-of-band process.                                       |
| POS devices           | Device registration by a manager. Long-lived, location-bound, revocable **device session**. Staff identify with a PIN for attribution, limited to that device and location. Sensitive operations need manager step-up. |
| Customers (QR/online) | No login. Scoped, short-lived session bound to one table session or order token. Unguessable tokens. Rate limits.                                                                                                      |

## CSRF, CORS, browser security

- Same-origin architecture (`/api` behind the same host). CORS is deny-by-default, with no wildcard and no credentialed cross-origin access.
- CSRF: `SameSite=Lax` plus a synchronizer or double-submit token header required on all state-changing requests,
  plus `Origin`/`Referer` verification against the brand host list. Socket.IO handshake checks `Origin`.
- Headers: strict CSP (nonce-based for Next.js), `frame-ancestors 'none'`, HSTS (preload after domains stabilize),
  `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`. `X-Powered-By` disabled.
- Output encoding by React by default. No `dangerouslySetInnerHTML` with user or brand content. SVG uploads rejected or sanitized.

## Authorization

- **RBAC with permissions:** code checks permissions (`orders.refund`), never role names.
- **Scopes:** platform permissions and tenant permissions are disjoint catalogs. A tenant role can never contain a platform permission.
- **Tenant- and location-aware:** every check takes the `AccessContext` (tenant from membership) and the target resource's tenant/location.
- **Least privilege defaults:** new staff get the minimum role. Owners cannot grant subscription or entitlement powers (those do not exist at tenant scope).
- **Both checks:** `authorize()` (permission) **and** `requireFeature()` (entitlement) in the application layer for HTTP, WebSocket, jobs and integrations.
- 404 for resources outside the caller's tenant (no existence oracle).

## Tenant isolation

See [03-tenant-isolation.md](../architecture/03-tenant-isolation.md): access context from membership, query scoping,
**PostgreSQL RLS with transaction-local context (fail closed)**, composite FKs, scoped rooms, caches, storage keys
and exports, plus a merge-blocking cross-tenant test suite.

## Privileged platform operations

Platform admins can affect thousands of restaurants, so:

- Separate route prefix (`/api/v1/platform`) and UI route group, separate permissions, **MFA mandatory**, shorter session lifetime.
- High-impact changes (bulk plan changes, global kill switches, brand or domain changes, tenant suspension) use **preview → confirm**,
  re-authentication, and optionally a **second approver** (four-eyes) for the riskiest operations.
- **No unrestricted impersonation.** Support access uses explicit, time-boxed **support grants** (reason, scope, read-only by default;
  write access needs owner approval per policy). Every action records `actor` + `on_behalf_of_tenant`. The tenant can see grant history.
- Optional IP allow-listing or SSO for platform accounts.
- Break-glass production DB access: separate audited procedure, never the app credentials.

## Financial operations

Server-calculated totals only. Idempotency keys on order, payment and refund. Row locks during checkout. Refunds and voids
need specific permissions, manager step-up and a reason, and are always audited. No card data (PAN) touches our
servers (provider tokenization or terminal integration), to minimize PCI DSS scope. Payment provider callbacks are
signature-verified and idempotent.

## Audit logging

Append-only (`INSERT`/`SELECT` only for the app role). Covers: authentication events, permission and role changes,
membership changes, support grants and their use, subscription/plan/override changes, brand changes, refunds and
voids, price changes, exports, settings changes. Written in the same transaction as the change. Retention to be agreed.
Optional hash chaining for tamper evidence.

## Data protection

- TLS everywhere (clients to edge, edge to app, app to DB/Redis with certificate verification in production).
- Encryption at rest on managed DB, Redis, storage and backups. Application-level encryption for especially sensitive fields
  (integration credentials stored only as secret-manager references).
- Personal data minimization (online-order customer data), retention jobs, and access logging. APPI obligations to be confirmed with the partner.
- Logs: structured, with a redaction list (passwords, tokens, cookies, `authorization` header, personal data fields). Logs never contain secrets.

## Infrastructure and supply chain

- PostgreSQL and Redis never publicly reachable (private subnets; locally bound to `127.0.0.1`). Redis requires auth plus TLS in deployed environments.
- Secrets only in the secret manager. `.env` gitignored. CI secret scanning (gitleaks) on full history.
- Containers: minimal base, **non-root**, read-only root FS, `no-new-privileges`, all capabilities dropped, pinned base digests, Trivy scanning, SBOM.
- Dependencies: exact pins + lockfile, Dependabot, `pnpm audit` gate, install scripts allow-listed (`onlyBuiltDependencies`), minimal dependency policy.
- Environment separation: separate accounts/projects, credentials and data per environment. Staging never holds raw production personal data.
- Deployments via short-lived OIDC credentials (no long-lived cloud keys in CI).

## Monitoring and incident response

Security-relevant events (login failures, MFA failures, permission denials spikes, cross-tenant access denials, platform
admin actions, support grants) go to alerting. An incident response runbook (detection → containment → eradication →
recovery → notification → post-mortem) will live in `docs/operations/`. Notification duties under APPI (for example to the
Personal Information Protection Commission and affected individuals) to be confirmed with the partner's legal counsel.

## Verification plan

Automated tests (cross-tenant, authZ matrix, CSRF, session revocation, rate limits), SAST (CodeQL), DAST (ZAP) on staging,
dependency, secret and image scanning, an ASVS L2 checklist review before launch, and an **external penetration test** before go-live.
