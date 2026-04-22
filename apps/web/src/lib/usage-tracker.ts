import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { isOssMode } from '@/lib/storage/factory';
import type { EntitlementResource } from './entitlement';

function currentPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Increment a monthly-bucketed usage counter. No-op in OSS mode. */
export async function incrementUsage(
  orgId: string,
  resource: Extract<EntitlementResource, 'stories' | 'memos' | 'api_calls'>,
  count = 1,
): Promise<void> {
  if (isOssMode()) return;
  try {
    const supabase = createSupabaseAdminClient();
    const period = currentPeriod();
    // UPSERT row, then increment
    await supabase.rpc('increment_org_usage', { _org_id: orgId, _period: period, _resource: resource, _count: count });
  } catch {
    // usage tracking is best-effort — never block the main operation
  }
}

export interface OrgUsage {
  stories: number;
  memos: number;
  docs: number;
  api_calls: number;
  period: string;
}

export async function getCurrentUsage(orgId: string): Promise<OrgUsage | null> {
  if (isOssMode()) return null;
  const supabase = createSupabaseAdminClient();
  const { data } = await supabase
    .from('org_usage')
    .select('stories, memos, docs, api_calls, period')
    .eq('org_id', orgId)
    .eq('period', currentPeriod())
    .maybeSingle();
  return data as OrgUsage | null;
}
