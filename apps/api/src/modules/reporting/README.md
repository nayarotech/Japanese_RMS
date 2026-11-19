# reporting

**Purpose:** Sales and operational reporting for restaurants (and commercial reporting for the platform).

**Owns**

- Read models and summaries (daily sales by business date, by product, by payment method, by channel).
- Report queries and exports (CSV/PDF), generated asynchronously by the worker for large ranges.

**Does not own**

- Source transactional data. It reads published events or read-only views and never mutates orders or payments.

**Notes:** Start with queries on normalized tables plus good indexes. Add denormalized summary tables (built by worker jobs from outbox events) only when measurements justify them. Advanced reports are gated by the `advanced_reports` entitlement.
