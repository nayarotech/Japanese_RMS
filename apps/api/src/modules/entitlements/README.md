# entitlements

**Purpose:** Answer "is feature X / limit Y available to this location **right now**?" in one place.

**Owns**

- **Feature registry in code**: the list of implemented feature keys (for example `pos`, `qr_ordering`, `online_ordering`). A DB row cannot enable a key that is not in the code registry.
- Resolution: subscription, plan version, features and limits, plus overrides and grants, intersected with the code registry and global kill switches, giving an effective snapshot.
- Enforcement API (planned): `requireFeature(ctx, locationId, key)`, `hasFeature(...)`, `checkLimit(ctx, locationId, limitKey, requested)`.
- Snapshot caching (Redis, versioned) and invalidation on `subscription.changed` events.

**Does not own**

- Plans or subscriptions (`subscriptions`). User permissions (`authorization`).

**Invariants**

- Enforced server-side for HTTP, WebSocket events, jobs and integrations. Frontend hiding is cosmetic only.
- Defined, documented fail-safe behaviour when resolution fails (see docs/architecture/04-subscription-entitlements.md).
