import { redirect } from 'next/navigation';
import { AgentWorkflowEditor } from '@/components/agents/agent-workflow-editor';
import { requireOrgAdmin } from '@/lib/admin-check';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { checkFeatureLimit } from '@/lib/check-feature';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AgentOrchestrationUpgradeState } from '@/components/agents/agent-orchestration-gate';
import { AgentRoutingRuleService } from '@/services/agent-routing-rule';
import type { WorkflowMember } from '@/services/agent-workflow-editor';
import { isOssMode } from '@/lib/storage/factory';

export default async function AgentWorkflowPage() {
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

  const [membersResult, projectResult] = await Promise.all([
    supabase
      .from('team_members')
      .select('id, name, type, role')
      .eq('org_id', me.org_id)
      .eq('project_id', me.project_id)
      .eq('is_active', true)
      .order('type', { ascending: false })
      .order('name', { ascending: true }),
    supabase
      .from('projects')
      .select('name')
      .eq('id', me.project_id)
      .maybeSingle(),
  ]);

  if (membersResult.error) throw membersResult.error;
  if (projectResult.error) throw projectResult.error;

  const service = new AgentRoutingRuleService(supabase);
  const rules = await service.listRules({ orgId: me.org_id, projectId: me.project_id });

  const members = (membersResult.data ?? []) as WorkflowMember[];
  const projectName = projectResult.data?.name ?? 'Current project';

  return <AgentWorkflowEditor initialMembers={members} initialRules={rules} projectName={projectName} />;
}
