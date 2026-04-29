import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';
import { checkFeatureLimit } from '@/lib/check-feature';
import { AgentsDashboard } from '@/components/agents/agents-dashboard';
import { buildDeploymentCards } from '@/services/agent-dashboard';
import { AgentOrchestrationUpgradeState } from '@/components/agents/agent-orchestration-gate';
import { AgentsTabBar } from '@/components/agents/agents-tab-bar';
import { WorkflowRulesTab } from '@/components/agents/workflow-rules-tab';
import { WorkflowDashboard } from '@/components/agents/workflow-dashboard';
import { AtomicContractLibrary } from '@/components/agents/atomic-contract-library';
import { CompositeLibrary } from '@/components/agents/composite-library';

export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const me = await getMyTeamMember(supabase, user);
  if (!me) redirect('/dashboard');

  await requireOrgAdmin(supabase, me.org_id).catch(() => redirect('/dashboard'));

  const gate = await checkFeatureLimit(supabase, me.org_id, 'agent_orchestration');
  if (!gate.allowed) return <AgentOrchestrationUpgradeState />;

  const { tab } = await searchParams;
  const activeTab = tab === 'rules' ? 'rules' : 'deployments';

  if (activeTab === 'rules') {
    return (
      <>
        <AgentsTabBar activeTab="rules" />
        <WorkflowDashboard orgId={me.org_id} projectId={me.project_id ?? undefined} />
        <div className="space-y-6 px-6 pb-2 pt-6">
          <AtomicContractLibrary orgId={me.org_id} projectId={me.project_id ?? undefined} />
          <CompositeLibrary orgId={me.org_id} projectId={me.project_id ?? undefined} />
        </div>
        <WorkflowRulesTab orgId={me.org_id} projectId={me.project_id ?? undefined} />
      </>
    );
  }

  const cards = await buildDeploymentCards(supabase, me.org_id, me.project_id, me.id);
  return (
    <>
      <AgentsTabBar activeTab="deployments" />
      <AgentsDashboard deployments={cards} />
    </>
  );
}
