# src/branding/

Server-side resolution of the active white-label brand.

Planned flow: request `Host` header, then (server only) `GET /api/v1/public/brand?host=…` (cached, public fields only), then:

- `generateMetadata()` sets title, description, icons and Open Graph from the brand;
- the root layout injects brand color tokens as CSS variables;
- the brand display name, support contact and legal links come from the brand context.

An unknown host renders a neutral page and never falls back to a hard-coded brand. Not implemented in Phase 0.
