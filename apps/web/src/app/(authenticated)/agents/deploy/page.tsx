import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';
import { checkFeatureLimit } from '@/lib/check-feature';
import { AgentPersonaService } from '@/services/agent-persona';
import { resolveAutoRoutingPersonaRole } from '@/services/agent-routing-template';
import { AgentOrchestrationUpgradeState } from '@/components/agents/agent-orchestration-gate';
import { isOssMode } from '@/lib/storage/factory';
import {
  AgentDeploymentWizard,
  type WizardDefaults,
  type WizardExistingDeployment,
  type WizardPersona,
  type WizardProject,
} from '@/components/agents/agent-deployment-wizard';

const LIVE_DEPLOYMENT_STATUSES = ['DEPLOYING', 'ACTIVE', 'SUSPENDED'];

function getBasePersonaId(config: unknown): string | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const basePersonaId = (config as Record<string, unknown>).base_persona_id;
  return typeof basePersonaId === 'string' && basePersonaId.trim() ? basePersonaId.trim() : null;
}

export default async function AgentDeployPage() {
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
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const me = await getMyTeamMember(supabase, user);
  if (!me) redirect('/dashboard');

  await requireOrgAdmin(supabase, me.org_id).catch(() => redirect('/dashboard'));

  const gate = await checkFeatureLimit(supabase, me.org_id, 'agent_orchestration');
  if (!gate.allowed) return <AgentOrchestrationUpgradeState />;

  const [{ data: agents }, { data: orgAgents }, { data: projects }, { data: aiSettings }, { data: byomIntegration }, { data: customPersonas }, { data: liveDeployments }, { data: existingRoutingRules }] = await Promise.all([
    supabase
      .from('team_members')
      .select('id, name')
      .eq('org_id', me.org_id)
      .eq('project_id', me.project_id)
      .eq('type', 'agent')
      .eq('is_active', true)
      .order('created_at', { ascending: true }),
    supabase
      .from('team_members')
      .select('id, name')
      .eq('org_id', me.org_id)
      .eq('type', 'agent')
      .eq('is_active', true),
    supabase
      .from('projects')
      .select('id, name')
      .eq('org_id', me.org_id)
      .order('name'),
    supabase
      .from('project_ai_settings')
      .select('provider, llm_config')
      .eq('org_id', me.org_id)
      .eq('project_id', me.project_id)
      .maybeSingle(),
    supabase
      .from('org_integrations')
      .select('provider, secret_last4')
      .eq('org_id', me.org_id)
      .eq('project_id', me.project_id)
      .eq('integration_type', 'byom_api_key')
      .maybeSingle(),
    supabase
      .from('agent_personas')
      .select('id, name, description, is_builtin, project_id, agent_id, slug, config')
      .eq('org_id', me.org_id)
      .eq('is_builtin', false)
      .is('deleted_at', null)
      .order('updated_at', { ascending: false }),
    supabase
      .from('agent_deployments')
      .select('id, agent_id, persona_id, status')
      .eq('org_id', me.org_id)
      .eq('project_id', me.project_id)
      .is('deleted_at', null)
      .in('status', LIVE_DEPLOYMENT_STATUSES),
    supabase
      .from('agent_routing_rules')
      .select('id')
      .eq('org_id', me.org_id)
      .eq('project_id', me.project_id)
      .is('deleted_at', null),
  ]);

  const primaryAgent = (agents ?? [])[0] as { id: string; name: string } | undefined;
  const personaService = new AgentPersonaService(supabase as never);
  const builtinAndScoped = primaryAgent
    ? await personaService.listPersonas({ orgId: me.org_id, projectId: me.project_id, agentId: primaryAgent.id, includeBuiltin: true })
    : [];

  const projectNameById = Object.fromEntries((projects ?? []).map((project) => [project.id as string, project.name as string]));
  const agentNameById = Object.fromEntries((orgAgents ?? []).map((agent) => [agent.id as string, agent.name as string]));
  const currentAgentRoleByPersonaId = new Map(
    builtinAndScoped.map((persona) => [
      persona.id,
      resolveAutoRoutingPersonaRole({ slug: persona.slug, basePersonaSlug: persona.base_persona?.slug ?? null }),
    ]),
  );

  const customBasePersonaIds = [...new Set((customPersonas ?? [])
    .map((persona) => getBasePersonaId(persona.config))
    .filter((value): value is string => Boolean(value)))];
  const { data: customBasePersonas } = customBasePersonaIds.length > 0
    ? await supabase
        .from('agent_personas')
        .select('id, slug')
        .eq('org_id', me.org_id)
        .is('deleted_at', null)
        .in('id', customBasePersonaIds)
    : { data: [] as Array<{ id: string; slug: string }> };
  const customBaseSlugById = new Map((customBasePersonas ?? []).map((persona) => [persona.id as string, persona.slug as string])) as Map<string, string>;

  const orgCustomPersonas = (customPersonas ?? []).map((persona) => ({
    id: persona.id as string,
    name: persona.name as string,
    description: (persona.description as string | null) ?? null,
    is_builtin: false,
    project_name: projectNameById[persona.project_id as string] ?? null,
    agent_name: agentNameById[persona.agent_id as string] ?? null,
    slug: persona.slug as string,
    base_persona_slug: customBaseSlugById.get(getBasePersonaId(persona.config) ?? '') ?? null,
    role: currentAgentRoleByPersonaId.get(persona.id as string)
      ?? resolveAutoRoutingPersonaRole({
        slug: persona.slug as string,
        basePersonaSlug: customBaseSlugById.get(getBasePersonaId(persona.config) ?? '') ?? null,
      }),
  }));

  const builtinPersonas = builtinAndScoped.filter((persona) => persona.is_builtin).map((persona) => ({
    id: persona.id,
    name: persona.name,
    description: persona.description,
    is_builtin: true,
    slug: persona.slug,
    base_persona_slug: persona.base_persona?.slug ?? null,
    role: currentAgentRoleByPersonaId.get(persona.id) ?? 'unknown',
  }));

  const livePersonaIds = [...new Set((liveDeployments ?? [])
    .map((deployment) => deployment.persona_id as string | null)
    .filter((value): value is string => Boolean(value)))];
  const { data: livePersonas } = livePersonaIds.length > 0
    ? await supabase
        .from('agent_personas')
        .select('id, slug, config')
        .eq('org_id', me.org_id)
        .is('deleted_at', null)
        .in('id', livePersonaIds)
    : { data: [] as Array<{ id: string; slug: string; config: unknown }> };
  const liveBasePersonaIds = [...new Set((livePersonas ?? [])
    .map((persona) => getBasePersonaId(persona.config))
    .filter((value): value is string => Boolean(value)))];
  const { data: liveBasePersonas } = liveBasePersonaIds.length > 0
    ? await supabase
        .from('agent_personas')
        .select('id, slug')
        .eq('org_id', me.org_id)
        .is('deleted_at', null)
        .in('id', liveBasePersonaIds)
    : { data: [] as Array<{ id: string; slug: string }> };
  const livePersonaById = new Map((livePersonas ?? []).map((persona) => [persona.id as string, persona]));
  const liveBaseSlugMap = new Map((liveBasePersonas ?? []).map((persona) => [persona.id as string, persona.slug as string]));

  const existingDeployments: WizardExistingDeployment[] = (liveDeployments ?? []).map((deployment) => {
    const persona = deployment.persona_id ? livePersonaById.get(deployment.persona_id as string) : null;
    const personaAny = persona as any;
    const basePersonaSlug = persona ? (liveBaseSlugMap.get(getBasePersonaId(personaAny.config) ?? '') ?? null) as string | null : null;
    return {
      id: deployment.id as string,
      agentId: deployment.agent_id as string,
      agentName: agentNameById[deployment.agent_id as string] ?? (deployment.agent_id as string),
      personaId: (deployment.persona_id as string | null) ?? null,
      role: resolveAutoRoutingPersonaRole({
        slug: (personaAny?.slug as string | undefined) ?? null,
        basePersonaSlug,
      }),
    };
  });

  const personas = [...builtinPersonas, ...orgCustomPersonas];

  const projectAiProvider = ((byomIntegration?.provider as WizardDefaults['projectAiProvider'] | undefined)
    ?? (aiSettings?.provider as WizardDefaults['projectAiProvider'] | undefined)
    ?? null);

  const defaults: WizardDefaults = {
    provider: (aiSettings?.provider as WizardDefaults['provider'] | undefined) ?? 'openai',
    model: ((aiSettings?.llm_config as { model?: string } | null)?.model ?? 'gpt-4o-mini') as string,
    hasProjectApiKey: Boolean(byomIntegration?.secret_last4),
    projectAiProvider,
  };

  return (
    <AgentDeploymentWizard
      agent={primaryAgent ? { id: primaryAgent.id, name: primaryAgent.name } : null}
      personas={personas as WizardPersona[]}
      projects={(projects ?? []).map((project) => ({ id: project.id as string, name: project.name as string })) as WizardProject[]}
      currentProjectId={me.project_id}
      currentProjectName={(projects ?? []).find((project) => project.id === me.project_id)?.name as string | null}
      defaults={defaults}
      existingDeployments={existingDeployments}
      existingRoutingRuleCount={(existingRoutingRules ?? []).length}
    />
  );
}
