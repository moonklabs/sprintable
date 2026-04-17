import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';
import { checkFeatureLimit } from '@/lib/check-feature';
import { AgentOrchestrationUpgradeState } from '@/components/agents/agent-orchestration-gate';
import { AgentHitlRequestsList } from '@/components/agents/agent-hitl-requests-list';
import { isOssMode } from '@/lib/storage/factory';

export default async function AgentHitlRequestsPage() {
  if (isOssMode()) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center space-y-2">
        <h2 className="text-xl font-semibold">OSS 버전 미제공 기능인.</h2>
        <p className="text-muted-foreground">에이전트 배포 관리는 SaaS 버전에서 이용 가능한.</p>
      </div>
    );
  }
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const me = await getMyTeamMember(supabase, user);
  if (!me) redirect('/dashboard');

  await requireOrgAdmin(supabase, me.org_id).catch(() => redirect('/dashboard'));

  const gate = await checkFeatureLimit(supabase, me.org_id, 'agent_orchestration');
  if (!gate.allowed) return <AgentOrchestrationUpgradeState />;

  return <AgentHitlRequestsList />;
}
