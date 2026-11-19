# audit

**Purpose:** Durable, append-only record of security-relevant and privileged actions.

**Owns**

- Audit events: actor (and on-behalf-of for support access), tenant, location, action, target, before/after summary, request id, IP or device, timestamp.
- Query and export for platform admins (all tenants) and tenant owners (their tenant only).

**Invariants**

- The application DB role has `INSERT` and `SELECT` only on audit tables. No `UPDATE` or `DELETE`.
- Audit write happens in the same transaction as the audited change wherever possible.
- Never log secrets, passwords, full tokens or payment card data.
