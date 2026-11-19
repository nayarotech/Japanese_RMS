# 0003. Feature entitlements as configurable data over a code feature registry, separate from authorization

- **Status:** Proposed
- **Date:** 2026-11-19
- **Related:** docs/architecture/04-subscription-entitlements.md

## Context

Packages (Basic/Standard/Premium/Platinum…) are not final and will change. Each feature must exist once and
be shared across plans. Admins must configure plans without code changes, but must not be able to "enable"
features that do not exist.

## Decision

- Feature keys are declared in a **code registry**. The DB holds plans, **immutable plan versions**, feature mappings,
  limits, subscriptions and time-boxed overrides. Effective features = DB configuration ∩ code registry ∩ global kill switches.
- A central `entitlements` module exposes `requireFeature` / `checkLimit`, called in application use cases for HTTP, WS, jobs and integrations.
- Entitlements (what the restaurant bought) and authorization (what this user may do) are separate modules and separate checks.
- Payment status does not drive access directly. A configurable access policy maps subscription status to an access mode.
- The originally proposed `billing` module is named **`payments`** (diner checkout) to keep it distinct from `subscriptions` (SaaS commerce).

## Consequences

- Positive: plan matrix changes are data changes, single implementation per feature, auditable.
- Negative: every gated use case must remember to call `requireFeature`. Mitigated by tests that assert gating for each feature key.
- Open: subscription subject (location vs. tenant), access policy per status, POS continuity on resolution errors.
