# E. White-label branding

## Requirement

The development company's brand must **never** appear in anything a customer, restaurant or partner end user
can see: app name, logos, titles, favicons, metadata, URLs, QR pages, POS, dashboards, receipts, invoices,
emails, notifications, error pages, public API docs, support information.

Internally the project uses the neutral name `restaurant-platform` (package scope `@restaurant-platform/*`).

## Brand model (planned)

| Level                                                 | Configured by                                  | Fields                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Brand** (partner-level)                             | Platform admins (`platform.branding.manage`)   | `display_name` (JA/EN), logo variants, favicon set, color tokens, typography choice, public metadata (title template, description, OG image), support contact (email/phone/hours), legal links (terms, privacy, 特定商取引法 page if applicable), email sender identity, template overrides. |
| **Brand domain**                                      | Platform admins                                | `host` → brand, verification status, TLS status, primary flag. Unknown hosts get no brand.                                                                                                                                                                                                   |
| **Restaurant customization** (optional, within brand) | Restaurant admins (`restaurant.branding.edit`) | Restaurant display name and logo on QR/online pages and receipts, receipt header and footer text. Cannot override brand identity, support contact or legal links.                                                                                                                            |

Assets live in object storage (`brands/{brandId}/…`), uploaded via signed URLs, validated for type and size
and stripped of metadata. **SVG uploads are either rejected or sanitized** (SVG can carry scripts).

## Resolution at runtime

```
request Host -> web server (Next.js) -> GET /api/v1/public/brand?host=…   (cached in Redis + Next cache, short TTL)
             -> returns PUBLIC fields only (never admin notes, sender credentials, internal ids beyond brand id)
             -> generateMetadata(): <title>, description, icons, OG
             -> root layout: CSS variables from color tokens; brand context for name, support, legal links
api (emails/receipts/notifications) -> brand from the tenant's brand assignment (not from the request host)
```

- **Unknown host:** neutral, unbranded "not found" page with no fallback brand and no developer identity.
- **Build artifacts are brand-free.** One web image serves all brands. No per-brand builds or forks.
- Customer-facing API errors use generic messages and stable codes. They contain no stack traces, server banners or library names (`X-Powered-By` disabled, `server_tokens off`).
- Public API documentation, if published, is generated with brand variables and hosted under the brand domain.

## Where branding is consumed

| Surface                                   | Source of brand                                     |
| ----------------------------------------- | --------------------------------------------------- |
| Web pages, metadata, favicon, error pages | Host → brand                                        |
| QR ordering / online ordering pages       | Host → brand, plus restaurant customization         |
| Emails / notifications                    | Tenant → brand (sender name, logo, footer, support) |
| Receipts / invoices                       | Tenant → brand, plus location receipt settings      |
| PDF/CSV exports                           | Tenant → brand (header), neutral file names         |

## Leak prevention controls

1. **No literal brand strings** in components. Product name and support details always come from brand context or i18n placeholders (`{brandName}`).
2. `apps/web/public/` holds no brand assets (documented in its README).
3. **CI brand-leak check** (`scripts/check-brand-leak.sh`, created): fails the build if any term from the
   `BRAND_DENYLIST` CI variable appears under `apps/` or `packages/`. The denylist is kept outside the repo.
4. Third-party scripts or widgets that display vendor branding are not allowed on customer surfaces without review.
5. Default email "From" is the brand's verified sender domain (SPF/DKIM/DMARC configured by the partner's domain owner).
6. Review checklist item for every PR touching customer-facing output: "Does any developer identity appear?"

## Security

Brand edits are platform-admin only, MFA-protected, audited, previewable before publish, and propagated by
an outbox event that invalidates caches. Custom-domain onboarding requires DNS verification before the host is
activated, to prevent hostile domain claims.
