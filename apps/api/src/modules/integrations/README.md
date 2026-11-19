# integrations

**Purpose:** Isolate third-party services behind module-owned ports.

**Owns**

- Adapters for external systems such as HotPepper or Google review management (examples; scope not yet approved).
- Credential storage references (secret manager), webhook signature verification, inbound idempotency.
- Per-integration entitlement checks (`hotpepper_integration` and so on) on **every** inbound and outbound call, including jobs.

**Rules:** External payloads are untrusted input: validate with Zod, map to internal commands, never pass raw provider data into domain logic. Outbound calls run in worker jobs with timeouts, retries and circuit breaking. They never run inside a DB transaction.
