# apps/web

One Next.js (App Router) application serving every UI surface. Separate surfaces are **route groups**, not separate apps.
White-label: the app contains **no brand**. Everything brand-visible is resolved at request time from the host (see `src/branding/`).

| Path              | Responsibility                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `src/app/`        | Routes (App Router). Planned route groups listed in its README.                                       |
| `src/features/`   | UI feature slices per business area (menus, orders, POS…), mirroring API modules. Calls the API only. |
| `src/components/` | Accessible, brand-neutral reusable UI primitives (styled via CSS variables from brand tokens).        |
| `src/i18n/`       | Locale config and message catalogs (`ja` default, `en`). No hard-coded UI strings in components.      |
| `src/branding/`   | Server-side brand resolution and theme-token injection.                                               |
| `src/lib/`        | API client, Socket.IO client wrapper, formatting helpers (JPY, dates in Asia/Tokyo).                  |
| `public/`         | Brand-neutral static files only. **No logos, favicons or brand names.**                               |

**Status:** Phase 0. Next.js, React, Tailwind, Zod and the i18n library are **not installed**; no pages exist.
`next.config.ts` and Tailwind config are added in Phase 1 with `output: "standalone"` for the Docker image.

**Security rule:** the UI may hide what the user cannot use, but the API is the only enforcement point
for authentication, authorization, tenant scoping and entitlements.
