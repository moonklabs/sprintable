import { describe, expect, it } from 'vitest';

import {
  BILLING_ENTITLEMENT_SOURCE_PRIORITY,
  BILLING_PLAN_ORDER,
  getEntitlementBearingSubscription,
  ENTITLEMENT_ACTIVE_SUBSCRIPTION_STATUSES,
  TRIAL_DURATION_DAYS,
  TRIAL_LIMIT_PER_ORG,
  TRIAL_PLAN_NAME,
  isEntitlementActiveSubscriptionStatus,
} from './billing-policy';

describe('billing-policy', () => {
  it('pins the commercial plan order and trial baseline', () => {
    expect(BILLING_PLAN_ORDER).toEqual(['free', 'team', 'pro']);
    expect(TRIAL_PLAN_NAME).toBe('team');
    expect(TRIAL_DURATION_DAYS).toBe(14);
    expect(TRIAL_LIMIT_PER_ORG).toBe(1);
  });

  it('treats trialing subscriptions as entitlement-bearing', () => {
    expect(ENTITLEMENT_ACTIVE_SUBSCRIPTION_STATUSES).toEqual(['active', 'trialing']);
    expect(isEntitlementActiveSubscriptionStatus('active')).toBe(true);
    expect(isEntitlementActiveSubscriptionStatus('trialing')).toBe(true);
    expect(isEntitlementActiveSubscriptionStatus('canceled')).toBe(false);
    expect(isEntitlementActiveSubscriptionStatus('past_due')).toBe(false);
  });


  it('filters non-entitled subscription rows through the shared resolver', async () => {
    const makeSupabase = (status: string | null) => ({
      from() {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: status ? { status, tier_id: 'tier-1' } : null, error: null }),
        };
      },
    });

    await expect(getEntitlementBearingSubscription(makeSupabase('trialing') as never, 'org-1', 'status, tier_id')).resolves.toEqual({ status: 'trialing', tier_id: 'tier-1' });
    await expect(getEntitlementBearingSubscription(makeSupabase('canceled') as never, 'org-1', 'status, tier_id')).resolves.toBeNull();
  });

  it('documents the entitlement resolution priority', () => {
    expect(BILLING_ENTITLEMENT_SOURCE_PRIORITY).toEqual([
      'subscriptions.offering_snapshot_id -> plan_offering_snapshots.features',
      'legacy subscriptions without snapshot -> plan_features',
      'no entitled subscription -> current free snapshot',
    ]);
  });
});
