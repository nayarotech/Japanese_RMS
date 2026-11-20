/**
 * subscriptions: which plan version a location is on. Phase 1 scope is read-only resolution;
 * plan management, overrides and partner sync are future work (docs/architecture/04-subscription-entitlements.md).
 */
import type { Tx } from "../../infrastructure/database/db.js";
import type { SubscriptionsTable } from "../../infrastructure/database/schema.js";

export type SubscriptionStatus = SubscriptionsTable["status"];

export interface CurrentPlanFeatures {
  subscriptionId: string;
  status: SubscriptionStatus;
  planCode: string;
  featureKeys: string[];
}

export async function getCurrentPlanFeatures(
  tx: Tx,
  locationId: string,
): Promise<CurrentPlanFeatures | null> {
  const sub = await tx
    .selectFrom("subscriptions as s")
    .innerJoin("plan_versions as pv", "pv.id", "s.plan_version_id")
    .innerJoin("plans as p", "p.id", "pv.plan_id")
    .select(["s.id", "s.status", "s.plan_version_id", "p.code"])
    .where("s.location_id", "=", locationId)
    .where("s.status", "in", ["trial", "active", "past_due", "suspended"])
    .where("s.starts_at", "<=", new Date())
    .where((eb) => eb.or([eb("s.ends_at", "is", null), eb("s.ends_at", ">", new Date())]))
    .executeTakeFirst();
  if (!sub) return null;
  const features = await tx
    .selectFrom("plan_version_features")
    .select("feature_key")
    .where("plan_version_id", "=", sub.plan_version_id)
    .execute();
  return {
    subscriptionId: sub.id,
    status: sub.status,
    planCode: sub.code,
    featureKeys: features.map((f) => f.feature_key),
  };
}
