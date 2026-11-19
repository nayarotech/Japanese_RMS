# online-orders

**Purpose:** Remote ordering with **pickup** and **delivery** fulfilment.

**Owns**

- Online order intake (customer contact details, requested time), acceptance or rejection by the restaurant.
- Pickup slot management. Delivery zones, fees and status tracking.
- Customer-facing order status page (by unguessable token).

**Does not own**

- Order totals and items (`orders`). Payment (`payments`). Notifications (`notifications`).

**Notes:** Gated by entitlements `online_ordering`, `pickup_ordering` and `delivery_management`. Contains customer personal data, so it must follow the APPI requirements confirmed by the partner (retention and access). Pickup and delivery may split into separate modules later if they grow.
