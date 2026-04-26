import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';
import { checkFeatureLimit } from '@/lib/check-feature';
import { AgentPersonaComposer, type PersonaComposerAgent, type PersonaComposerPersona } from '@/components/agents/agent-persona-composer';
import { AgentOrchestrationUpgradeState } from '@/components/agents/agent-orchestration-gate';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { buttonVariants } from '@/components/ui/button';
import { AgentPersonaService, MANAGED_SAFETY_LAYER_NOTICE } from '@/services/agent-persona';
import { listProjectPersonaToolOptions } from '@/services/persona-composer';
import { isOssMode } from '@/lib/storage/factory';

export default async function NewAgentPersonaPage() {
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
  const t = await getTranslations('agents');
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const me = await getMyTeamMember(supabase, user);
  if (!me) redirect('/dashboard');

  await requireOrgAdmin(supabase, me.org_id).catch(() => redirect('/dashboard'));

  const gate = await checkFeatureLimit(supabase, me.org_id, 'agent_orchestration');
  if (!gate.allowed) return <AgentOrchestrationUpgradeState />;

  const [{ data: agentRows }, toolOptions] = await Promise.all([
    supabase
      .from('team_members')
      .select('id, name')
      .eq('org_id', me.org_id)
      .eq('project_id', me.project_id)
      .eq('type', 'agent')
      .eq('is_active', true)
      .order('created_at', { ascending: true }),
    listProjectPersonaToolOptions(supabase as never, me.project_id),
  ]);

  const agents = (agentRows ?? []).map((agent) => ({
    id: agent.id as string,
    name: agent.name as string,
  })) satisfies PersonaComposerAgent[];

  const personaService = new AgentPersonaService(supabase as never);
  const personasByAgentId = Object.fromEntries(await Promise.all(agents.map(async (agent) => {
    const personas = await personaService.listPersonas({
      orgId: me.org_id,
      projectId: me.project_id,
      agentId: agent.id,
      includeBuiltin: true,
    });

    return [agent.id, personas.map((persona) => ({
      id: persona.id,
      name: persona.name,
      slug: persona.slug,
      description: persona.description,
      resolved_system_prompt: persona.resolved_system_prompt,
      resolved_style_prompt: persona.resolved_style_prompt,
      tool_allowlist: persona.tool_allowlist,
      version_metadata: persona.version_metadata,
      permission_boundary: persona.permission_boundary,
      change_history: persona.change_history,
      is_builtin: persona.is_builtin,
      is_default: persona.is_default,
    })) satisfies PersonaComposerPersona[]] as const;
  })));

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6 space-y-6">
      <PageHeader
        eyebrow={t('personaComposerEyebrow')}
        title={t('personaComposerTitle')}
        description={t('personaComposerDescription')}
        actions={<Link href="/agents/deploy" className={buttonVariants({ variant: 'hero', size: 'lg' })}>{t('backToWizard')}</Link>}
      />

      {agents.length === 0 ? (
        <EmptyState
          title={t('personaComposerNoAgentsTitle')}
          description={t('personaComposerNoAgentsDescription')}
          action={<Link href="/agents/deploy" className={buttonVariants({ variant: 'glass' })}>{t('backToWizard')}</Link>}
        />
      ) : (
        <AgentPersonaComposer
          agents={agents}
          personasByAgentId={personasByAgentId}
          toolOptions={toolOptions}
          safetyLayerNotice={MANAGED_SAFETY_LAYER_NOTICE}
        />
      )}
    </div>
  );
}
