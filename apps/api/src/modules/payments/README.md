# payments

**Purpose:** Restaurant **checkout**: money paid by diners to the restaurant.

(Renamed from the originally proposed `billing` to keep it clearly separate from SaaS subscription billing. See ADR-0003.)

**Owns**

- Checkout of an order or table session: payment records (cash, card, QR payments and so on), change due, split or partial payments where approved.
- Refunds and voids with manager authorization (step-up) and audit.
- Payment-provider adapters (terminal or online gateway), selected later.
- Idempotent payment attempts and retries, and reconciliation with provider callbacks.

**Does not own**

- SaaS subscription charges (`subscriptions`, possibly collected externally by the partner).
- Order totals (`orders` calculates; `payments` settles against the authoritative total).

**Invariants**

- Integer yen. No floating point. Row-level lock on the order or session during checkout. Checkout event is emitted only after commit.
- No card data (PAN) is stored or handled by our servers. Use provider tokenization or a terminal so we stay out of PCI DSS scope wherever possible.
