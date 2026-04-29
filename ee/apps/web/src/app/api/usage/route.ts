import { createSupabaseServerClient } from '@/lib/supabase/server';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { TIER_QUOTAS } from '@/lib/entitlement';

function currentPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();

    const [{ data: sub }, { data: usageRow }] = await Promise.all([
      supabase
        .from('org_subscriptions')
        .select('tier, status')
        .eq('org_id', me.org_id)
        .maybeSingle(),
      supabase
        .from('org_usage')
        .select('stories, memos, docs, api_calls')
        .eq('org_id', me.org_id)
        .eq('period', currentPeriod())
        .maybeSingle(),
    ]);

    const tier = (!sub || sub.status === 'expired' || sub.status === 'past_due') ? 'free' : (sub.tier ?? 'free');
    const quotas = TIER_QUOTAS[tier] ?? TIER_QUOTAS['free']!;
    const usage = {
      stories: usageRow?.stories ?? 0,
      memos: usageRow?.memos ?? 0,
      docs: usageRow?.docs ?? 0,
      api_calls: usageRow?.api_calls ?? 0,
    };

    return apiSuccess({ tier, usage, quotas });
  } catch (err: unknown) { return handleApiError(err); }
}
