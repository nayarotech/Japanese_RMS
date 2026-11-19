# src/app/ (Next.js App Router)

Planned route groups (created when each surface is implemented):

| Route group          | URL prefix (proposal)     | Users                                   | Notes                                                                 |
| -------------------- | ------------------------- | --------------------------------------- | --------------------------------------------------------------------- |
| `(platform)`         | `/platform`               | Partner platform operators              | MFA required. Separate layout. Never linked from tenant UI.           |
| `(restaurant-admin)` | `/admin`                  | Restaurant owners and managers          | Staff, menus, tables, settings, reports.                              |
| `(pos)`              | `/pos`                    | Staff on registered POS devices         | Touch-optimized; resilient to reconnects (state resync on reconnect). |
| `(ordering)`         | `/t/[token]`, `/o/[slug]` | Customers: QR at table, online ordering | Public, anonymous, rate-limited, minimal JS, branded per domain.      |
| `(auth)`             | `/login`, `/recovery`     | All staff and operators                 | Branded sign-in. No account enumeration.                              |

Global files planned: `layout.tsx` (brand + locale providers, `generateMetadata` from brand), `not-found.tsx` and `error.tsx` (branded, no stack traces).
