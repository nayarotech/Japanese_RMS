# staff

**Purpose:** People who work at a restaurant and what role they hold where.

**Owns**

- Staff profiles (display name, employee code, optional POS PIN for quick switching on a device session).
- Role assignment per tenant and per location (references roles defined by `authorization`).
- Invitations and deactivation.

**Does not own**

- Login credentials and sessions (`identity`). Permission definitions (`authorization`).

**Notes:** Staff count may be a plan limit (`entitlements.checkLimit`). Deactivation must revoke sessions through `identity`.
