# restaurants

**Purpose:** Restaurant **branches / locations** inside a tenant and their operational configuration.

**Owns**

- Locations: name (JA/EN), address, phone, time zone (default `Asia/Tokyo`).
- Business-day cutoff (for example 04:00), opening hours, holiday settings.
- Tax configuration references (rates, inclusive or exclusive pricing, rounding rule) to be specified and approved before implementation.
- Receipt settings (restaurant name, registration number for invoices if applicable), within brand constraints.
- Ordering settings per channel (dine-in, QR, pickup, delivery), each gated by entitlements.

**Does not own**

- Tables (`tables`), menus (`menus`), staff (`staff`).

**Notes:** Every operational record elsewhere carries `(tenant_id, location_id)`. A tenant can have many locations; never assume one.
