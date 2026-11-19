# @restaurant-platform/contracts

The **wire contract** between frontend and backend. It is the only code shared by `apps/web` and `apps/api`.

**Belongs here**

- Zod schemas and inferred types for HTTP request/response DTOs that the web app sends or receives.
- WebSocket event names and payload schemas (server-to-client and client-to-server).
- Stable identifier catalogs the UI needs to know about: feature keys (for example `"online_ordering"`), permission keys and error codes.
  These are _identifiers only_. Whether a feature is enabled is decided by the API.
- Brand-public DTO (fields the public brand endpoint may return).

**Does not belong here**

- Business logic, database types, entitlement resolution, anything secret, or anything server-only.

Consumed by: `apps/web`, `apps/api`, `apps/worker`. Depends on: `zod` only (added in Phase 1).
**Status:** Phase 0 placeholder.
