import { redirect } from 'next/navigation';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';
import { checkFeatureLimit } from '@/lib/check-feature';
import { AgentsDashboard } from '@/components/agents/agents-dashboard';
import { buildDeploymentCards } from '@/services/agent-dashboard';
import { AgentOrchestrationUpgradeState } from '@/components/agents/agent-orchestration-gate';
import { isOssMode } from '@/lib/storage/factory';

export default async function AgentsPage() {
  if (isOssMode()) {
    return <AgentsDashboard deployments={[]} />;
  }
  const supabase = await (undefined as any);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const me = await getMyTeamMember(supabase, user);
  if (!me) redirect('/dashboard');

  await requireOrgAdmin(supabase, me.org_id).catch(() => redirect('/dashboard'));

  const gate = await checkFeatureLimit(supabase, me.org_id, 'agent_orchestration');
  if (!gate.allowed) return <AgentOrchestrationUpgradeState />;

  const cards = await buildDeploymentCards(supabase, me.org_id, me.project_id, me.id);

  return <AgentsDashboard deployments={cards} />;
}
