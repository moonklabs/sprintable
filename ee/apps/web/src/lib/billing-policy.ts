import type { SupabaseClient } from '@supabase/supabase-js';

export const BILLING_PLAN_ORDER = ['free', 'team', 'pro'] as const;

export type BillingPlanName = (typeof BILLING_PLAN_ORDER)[number];

export const TRIAL_PLAN_NAME: BillingPlanName = 'team';
export const TRIAL_DURATION_DAYS = 14;
export const TRIAL_LIMIT_PER_ORG = 1;

export const ENTITLEMENT_ACTIVE_SUBSCRIPTION_STATUSES = ['active', 'trialing'] as const;

export type EntitlementActiveSubscriptionStatus = (typeof ENTITLEMENT_ACTIVE_SUBSCRIPTION_STATUSES)[number];

export function isEntitlementActiveSubscriptionStatus(
  status: string | null | undefined,
): status is EntitlementActiveSubscriptionStatus {
  return ENTITLEMENT_ACTIVE_SUBSCRIPTION_STATUSES.includes(
    status as EntitlementActiveSubscriptionStatus,
  );
}

export const BILLING_ENTITLEMENT_SOURCE_PRIORITY = [
  'subscriptions.offering_snapshot_id -> plan_offering_snapshots.features',
  'legacy subscriptions without snapshot -> plan_features',
  'no entitled subscription -> current free snapshot',
] as const;

export const BILLING_POLICY_NOTES = {
  commercialTiersOnly: BILLING_PLAN_ORDER,
  trialUsesPaidSnapshotOf: TRIAL_PLAN_NAME,
  entitlementStatuses: ENTITLEMENT_ACTIVE_SUBSCRIPTION_STATUSES,
} as const;

export async function getEntitlementBearingSubscription<T extends { status?: string | null }>(
  supabase: SupabaseClient,
  orgId: string,
  _columns?: string, // kept for interface compatibility; org_subscriptions always returns tier + status
): Promise<T | null> {
  const { data } = await supabase
    .from('org_subscriptions')
    .select('tier, status')
    .eq('org_id', orgId)
    .maybeSingle();

  if (!data || !isEntitlementActiveSubscriptionStatus((data as { status?: string | null }).status)) {
    return null;
  }

  return data as unknown as T;
}
