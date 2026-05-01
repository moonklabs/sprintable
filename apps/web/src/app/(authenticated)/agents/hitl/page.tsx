import { redirect } from 'next/navigation';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';
import { checkFeatureLimit } from '@/lib/check-feature';
import { AgentOrchestrationUpgradeState } from '@/components/agents/agent-orchestration-gate';
import { AgentHitlRequestsList } from '@/components/agents/agent-hitl-requests-list';
import { isOssMode } from '@/lib/storage/factory';

export default async function AgentHitlRequestsPage() {
  if (isOssMode()) {
    return (
      <div className="flex h-64 items-center justify-center p-6 text-center">
        <div>
          <h2 className="text-base font-semibold text-foreground">OSS 버전 미제공 기능인.</h2>
          <p className="mt-1 text-sm text-muted-foreground">에이전트 배포 관리는 SaaS 버전에서 이용 가능한.</p>
        </div>
      </div>
    );
  }
  const supabase = await (undefined as any);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const me = await getMyTeamMember(supabase, user);
  if (!me) redirect('/dashboard');

  await requireOrgAdmin(supabase, me.org_id).catch(() => redirect('/dashboard'));

  const gate = await checkFeatureLimit(supabase, me.org_id, 'agent_orchestration');
  if (!gate.allowed) return <AgentOrchestrationUpgradeState />;

  return <AgentHitlRequestsList />;
}
