import type { SupabaseClient } from '@supabase/supabase-js';
import type { ISubscriptionRepository, Subscription, UpdateSubscriptionInput } from '@sprintable/core-storage';
import { fastapiCall } from '@sprintable/storage-supabase';

export class SupabaseSubscriptionRepository implements ISubscriptionRepository {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly accessToken: string = '',
  ) {}

  private get fastapi(): boolean { return Boolean(this.accessToken); }

  async getForOrg(orgId: string): Promise<Subscription | null> {
    if (this.fastapi) {
      try { return await fastapiCall<Subscription>('GET', `/api/v2/subscription/${orgId}`, this.accessToken); }
      catch { return null; }
    }
    const { data, error } = await this.supabase.from('subscriptions').select('*').eq('org_id', orgId).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const row = data as Record<string, unknown>;
    return {
      id: (row['id'] as string) ?? `sub-${orgId}`,
      org_id: orgId,
      plan: (row['tier_id'] as string) ?? 'free',
      status: (row['status'] as string) ?? 'active',
      current_period_start: (row['current_period_start'] as string | null) ?? null,
      current_period_end: (row['current_period_end'] as string | null) ?? null,
      cancel_at_period_end: Boolean(row['cancel_at_period_end'] ?? row['canceled_at']),
      metadata: (row['metadata'] as Record<string, unknown> | null) ?? null,
      created_at: (row['created_at'] as string) ?? '1970-01-01T00:00:00.000Z',
      updated_at: (row['updated_at'] as string) ?? '1970-01-01T00:00:00.000Z',
    };
  }

  async update(orgId: string, input: UpdateSubscriptionInput): Promise<Subscription> {
    if (this.fastapi) {
      return fastapiCall<Subscription>('PATCH', `/api/v2/subscription/${orgId}`, this.accessToken, { body: input });
    }
    const patch: Record<string, unknown> = {};
    if (input.plan !== undefined) patch['tier_id'] = input.plan;
    if (input.status !== undefined) patch['status'] = input.status;
    if (input.current_period_start !== undefined) patch['current_period_start'] = input.current_period_start;
    if (input.current_period_end !== undefined) patch['current_period_end'] = input.current_period_end;
    if (input.cancel_at_period_end !== undefined) patch['canceled_at'] = input.cancel_at_period_end ? new Date().toISOString() : null;
    if (input.metadata !== undefined) patch['metadata'] = input.metadata;
    const { error } = await this.supabase.from('subscriptions').update(patch).eq('org_id', orgId);
    if (error) throw error;
    const refreshed = await this.getForOrg(orgId);
    if (!refreshed) throw new Error(`Subscription not found after update: ${orgId}`);
    return refreshed;
  }
}
