# subscriptions

**Purpose:** The SaaS **commercial** relationship: which plan a restaurant is on.

**Owns**

- Plans, **immutable plan versions**, plan-feature mappings and plan limits (data, editable by authorized platform admins).
- Restaurant subscriptions: plan version, status (`trial`, `active`, `past_due`, `suspended`, `cancelled`, `expired`), effective dates, scheduled changes.
- Overrides and temporary feature grants (with reason, actor and expiry).
- Inbound **partner sync boundary**: externally confirmed subscription states (the partner may collect payment outside our system). Signed, idempotent, reconciled.
- Subscription audit history.

**Does not own**

- Effective feature resolution (`entitlements`). Diner payments (`payments`). Developer-fee reconciliation (separate future module, see the architecture doc).

**Invariants**

- Plan versions are never edited in place once assigned. Changes create a new version.
- Payment status alone never revokes operational access without an explicit, configured commercial policy.
