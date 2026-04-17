export interface Subscription {
  id: string;
  org_id: string;
  plan: string;
  status: string;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface UpdateSubscriptionInput {
  plan?: string;
  status?: string;
  current_period_start?: string | null;
  current_period_end?: string | null;
  cancel_at_period_end?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * SaaS-only. OSS 모드에서는 NullSubscriptionRepository를 사용하여
 * 항상 free-plan unlimited 응답을 반환한다.
 */
export interface ISubscriptionRepository {
  getForOrg(orgId: string): Promise<Subscription | null>;
  update(orgId: string, input: UpdateSubscriptionInput): Promise<Subscription>;
}
