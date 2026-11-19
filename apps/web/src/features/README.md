# src/features/

Feature slices mirroring backend modules (for example `menus/`, `orders/`, `pos/`, `qr-ordering/`). Each slice holds its
components, hooks and API calls. Slices do not import each other's internals; shared pieces move to `components/` or `lib/`.
Not implemented in Phase 0.
