# branding

**Purpose:** White-label configuration so no developer branding ever reaches customers.

**Owns**

- Partner **brands**: display name, logos, favicon, color tokens, public metadata, support contact, legal links.
- Brand domains (custom host to brand mapping, verified). Email sender identity and template branding. Receipt branding.
- Public brand resolution by host, returning **only** public fields.
- Optional restaurant-level customization within the brand (logo or name on QR pages and receipts).

**Does not own**

- Email sending (`notifications`). Asset storage mechanics (`infrastructure/storage`).

**Notes:** Brand changes are platform-admin operations, audited and cache-invalidated by event. See docs/architecture/05-white-label-branding.md.
