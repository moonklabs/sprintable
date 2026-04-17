import type { ISubscriptionRepository, Subscription, UpdateSubscriptionInput } from '../interfaces/ISubscriptionRepository';

/**
 * OSS 모드 전용. 항상 free 플랜을 반환하며 update는 no-op에 가깝다.
 */
export class NullSubscriptionRepository implements ISubscriptionRepository {
  private ossSubscription(orgId: string): Subscription {
    return {
      id: `oss-${orgId}`,
      org_id: orgId,
      plan: 'oss',
      status: 'active',
      current_period_start: null,
      current_period_end: null,
      cancel_at_period_end: false,
      metadata: { source: 'oss-null-repo' },
      created_at: '1970-01-01T00:00:00.000Z',
      updated_at: '1970-01-01T00:00:00.000Z',
    };
  }

  async getForOrg(orgId: string): Promise<Subscription | null> {
    return this.ossSubscription(orgId);
  }

  async update(orgId: string, _input: UpdateSubscriptionInput): Promise<Subscription> {
    return this.ossSubscription(orgId);
  }
}
