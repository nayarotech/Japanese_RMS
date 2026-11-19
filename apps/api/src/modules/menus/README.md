# menus

**Purpose:** What a location sells.

**Owns**

- Menus, categories, products, option groups and options, allergens, images (stored in object storage).
- Prices in integer yen (JPY has no minor unit), tax category per product (for example standard or reduced, pending tax spec).
- Availability (sold out, time windows, per-channel visibility for POS, QR or online).
- Localized names and descriptions (Japanese required, English optional).

**Does not own**

- Order item snapshots (`orders` copies name, price and tax category at order time).

**Notes:** Price changes never alter existing orders. Menu reads are hot for QR/online, so this is a candidate for caching once measured.
