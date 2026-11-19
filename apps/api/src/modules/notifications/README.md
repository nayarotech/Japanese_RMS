# notifications

**Purpose:** Outbound messages to people (not the real-time device feed).

**Owns**

- Email (and later SMS or LINE if approved) delivery via provider adapters, executed by worker jobs.
- Localized (`ja`, `en`) and **branded** templates: sender name, logo, footer and support contact from `branding`.
- Delivery attempts, retries and idempotency (a job processed twice must not send twice).

**Does not own**

- Real-time device updates (`infrastructure/websocket` plus outbox). Brand data (`branding`).
