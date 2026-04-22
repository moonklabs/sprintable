import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { isOssMode } from '@/lib/storage/factory';

export type EntitlementResource = 'stories' | 'memos' | 'docs' | 'members' | 'projects' | 'api_calls';

interface TierQuota {
  stories: number;
  memos: number;
  docs: number;
  members: number;
  projects: number;
  api_calls: number;
}

const UNLIMITED = 999_999_999;

export const TIER_QUOTAS: Record<string, TierQuota> = {
  free: { members: 5, projects: 1, stories: 100, memos: 500, docs: 50, api_calls: 10_000 },
  team: { members: 20, projects: 5, stories: 1_000, memos: 5_000, docs: 500, api_calls: 100_000 },
  pro: { members: UNLIMITED, projects: UNLIMITED, stories: UNLIMITED, memos: UNLIMITED, docs: UNLIMITED, api_calls: UNLIMITED },
};

export interface EntitlementResult {
  allowed: boolean;
  current: number;
  limit: number;
  upgradeUrl: string;
}

function currentPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function getOrgTier(supabase: SupabaseClient, orgId: string): Promise<string> {
  const { data } = await supabase
    .from('org_subscriptions')
    .select('tier, status')
    .eq('org_id', orgId)
    .maybeSingle();
  if (!data || data.status === 'expired' || data.status === 'past_due') return 'free';
  return data.tier ?? 'free';
}

export async function checkEntitlement(
  supabase: SupabaseClient,
  orgId: string,
  resource: EntitlementResource,
): Promise<EntitlementResult> {
  if (isOssMode()) return { allowed: true, current: 0, limit: UNLIMITED, upgradeUrl: '/upgrade' };

  const tier = await getOrgTier(supabase, orgId);
  const quota = TIER_QUOTAS[tier] ?? TIER_QUOTAS['free']!;
  const limit = quota[resource];
  const upgradeUrl = '/upgrade';

  if (limit === UNLIMITED) return { allowed: true, current: 0, limit, upgradeUrl };

  let current = 0;

  if (resource === 'members') {
    const { count } = await supabase
      .from('org_members')
      .select('*', { count: 'exact', head: true })
      .eq('org_id', orgId);
    current = count ?? 0;
  } else if (resource === 'projects') {
    const { count } = await supabase
      .from('projects')
      .select('*', { count: 'exact', head: true })
      .eq('org_id', orgId);
    current = count ?? 0;
  } else if (resource === 'docs') {
    // docs is cumulative, not monthly
    const { count } = await supabase
      .from('docs')
      .select('*', { count: 'exact', head: true })
      .eq('org_id', orgId);
    current = count ?? 0;
  } else {
    // monthly resources: stories, memos, api_calls
    const { data: usage } = await supabase
      .from('org_usage')
      .select(resource)
      .eq('org_id', orgId)
      .eq('period', currentPeriod())
      .maybeSingle();
    current = (usage as Record<string, number> | null)?.[resource] ?? 0;
  }

  return { allowed: current < limit, current, limit, upgradeUrl };
}

export async function checkMemberEntitlement(
  supabase: SupabaseClient,
  orgId: string,
): Promise<EntitlementResult> {
  return checkEntitlement(supabase, orgId, 'members');
}
