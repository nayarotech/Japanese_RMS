/**
 * entitlements: "is feature X available to this location right now?" in ONE place.
 *
 * - FEATURE_REGISTRY lists implemented features. A plan row or override naming an unknown key grants nothing.
 * - Effective features = (plan features ∪ active grants) − active revokes, ∩ registry, then the access policy.
 * - Access policy maps subscription status to an access mode, never raw payment state.
 * - Fails closed: no subscription or a resolution error means the gated action is denied.
 * - Enforced server-side for HTTP, WebSocket-triggered use cases, jobs and public QR flows.
 */
import type { Tx } from "../../infrastructure/database/db.js";
import { Errors } from "../../shared/errors/app-error.js";
import {
  getActiveOverrides,
  getCurrentPlanFeatures,
  type SubscriptionStatus,
} from "../subscriptions/index.js";

/** Implemented, shared features. One implementation each, used by every plan that includes it. */
export const FEATURE_REGISTRY = [
  "table_management",
  "dine_in_pos",
  "table_qr_ordering",
  "kitchen_workflow",
  "cash_checkout",
  // Standard package and above: online ordering storefront, pickup, delivery.
  "online_ordering",
  "pickup_ordering",
  "delivery_management",
] as const;
export type FeatureKey = (typeof FEATURE_REGISTRY)[number];

const REGISTRY = new Set<string>(FEATURE_REGISTRY);

/**
 * Placeholder commercial policy (pending partner approval): payment state alone never revokes access.
 * `suspended` is an explicit platform-admin action; until a policy is approved it disables gated features.
 */
const STATUS_GRANTS_ACCESS: Record<SubscriptionStatus, boolean> = {
  trial: true,
  active: true,
  past_due: true,
  suspended: false,
  cancelled: false,
  expired: false,
};

export interface EntitlementSnapshot {
  features: ReadonlySet<FeatureKey>;
  planCode: string | null;
  status: SubscriptionStatus | null;
}

export async function resolveEntitlements(
  tx: Tx,
  locationId: string,
): Promise<EntitlementSnapshot> {
  const current = await getCurrentPlanFeatures(tx, locationId);
  if (!current || !STATUS_GRANTS_ACCESS[current.status]) {
    return {
      features: new Set(),
      planCode: current?.planCode ?? null,
      status: current?.status ?? null,
    };
  }
  const keys = new Set(current.featureKeys);
  const overrides = await getActiveOverrides(tx, locationId);
  for (const o of overrides) if (o.effect === "grant") keys.add(o.featureKey);
  for (const o of overrides) if (o.effect === "revoke") keys.delete(o.featureKey); // revoke wins
  const features = new Set([...keys].filter((k): k is FeatureKey => REGISTRY.has(k)));
  return { features, planCode: current.planCode, status: current.status };
}

export async function hasFeature(
  tx: Tx,
  locationId: string,
  feature: FeatureKey,
): Promise<boolean> {
  return (await resolveEntitlements(tx, locationId)).features.has(feature);
}

export async function requireFeature(
  tx: Tx,
  locationId: string,
  feature: FeatureKey,
): Promise<void> {
  if (!(await hasFeature(tx, locationId, feature))) throw Errors.notEntitled(feature);
}
