# 0006. Authentication library selection

- **Status:** Open (decide before Phase 2)
- **Date:** 2026-11-19
- **Related:** docs/security/security-architecture.md

## Context

Requirements: server-side revocable sessions in PostgreSQL, secure cookies, Argon2id, MFA (TOTP + WebAuthn),
rate limiting hooks, account recovery, compatibility with Express 5 and Kysely, and coexistence with our own
authorization, RLS and tenant model. No custom protocol or crypto.

## Options

1. **Better Auth** (1.x): TypeScript, framework-agnostic, Kysely-based DB layer, 2FA/passkey plugins, session management.
   Must verify: schema ownership vs. our migrations, how its tables interact with RLS (auth tables are platform-level, not tenant-scoped),
   and keeping its organization features **off** so authorization stays in our module.
2. **Minimal stack on vetted primitives**: server-side session table we own + `@node-rs/argon2` + `otplib` (TOTP) + `@simplewebauthn/server`.
   Full control and small surface, but more code we must get right (still no custom crypto).
3. Hosted identity provider (Auth0/Cognito/Entra): offloads MFA and recovery, but adds cost and vendor branding risk on hosted pages (white-label constraint) and per-tenant complexity.

## Proposed direction

Spike Option 1 in Phase 2. Accept it if its schema, session model and white-label UI needs fit. Otherwise use Option 2.
Option 3 is unlikely because of white-label and cost constraints.
