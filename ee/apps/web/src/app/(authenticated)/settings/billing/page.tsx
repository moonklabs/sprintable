import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { TIER_QUOTAS } from '@/lib/entitlement';
import { BillingSection } from '@/components/settings/billing-section';

function currentPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export default async function BillingPage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const me = await getMyTeamMember(supabase, user);
  if (!me) redirect('/login');

  const [{ data: sub }, { data: usageRow }] = await Promise.all([
    supabase
      .from('org_subscriptions')
      .select('tier, status')
      .eq('org_id', me.org_id)
      .maybeSingle(),
    supabase
      .from('org_usage')
      .select('stories, memos, api_calls')
      .eq('org_id', me.org_id)
      .eq('period', currentPeriod())
      .maybeSingle(),
  ]);

  const tier = (!sub || sub.status === 'expired' || sub.status === 'past_due') ? 'free' : (sub.tier ?? 'free');
  const quotas = TIER_QUOTAS[tier] ?? TIER_QUOTAS['free']!;
  const usage: Record<string, number> = {
    stories: usageRow?.stories ?? 0,
    memos: usageRow?.memos ?? 0,
    api_calls: usageRow?.api_calls ?? 0,
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
      <h1 className="mb-6 text-xl font-semibold">Billing</h1>
      <BillingSection
        tier={tier}
        usage={usage}
        quotas={quotas as unknown as Record<string, number>}
      />
    </div>
  );
}
