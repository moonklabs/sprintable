import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { requireAgentOrchestration } from '@/lib/require-agent-orchestration';
import { createManagedAgentDeploymentSchema } from '@/lib/managed-agent-contract';
import {
  getProjectAiSettingsWithIntegration,
  hasProjectAiCredential,
  matchesProjectAiCredentialProvider,
  resolveProjectAiCredentialProvider,
} from '@/lib/llm/project-ai-settings';
import {
  AgentDeploymentLifecycleService,
  DeploymentLifecycleError,
  type DeploymentPreflightResult,
} from '@/services/agent-deployment-lifecycle';

async function getByomBlockingReason(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  projectId: string,
  input: { llm_mode: string; provider: string },
): Promise<string | null> {
  if (input.llm_mode !== 'byom') return null;

  const aiCredentialState = await getProjectAiSettingsWithIntegration(supabase as never, projectId);
  if (!hasProjectAiCredential(aiCredentialState)) {
    return `Project AI settings do not have a stored BYOM credential for provider ${input.provider}`;
  }

  if (!matchesProjectAiCredentialProvider(aiCredentialState, input.provider)) {
    const credentialProvider = resolveProjectAiCredentialProvider(aiCredentialState);
    return credentialProvider
      ? `Project AI settings are configured for provider ${credentialProvider}; BYOM deployments must use the same provider`
      : `Project AI settings provider does not match ${input.provider}`;
  }

  return null;
}

function mergeBlockingReason(preflight: DeploymentPreflightResult, reason: string | null): DeploymentPreflightResult {
  if (!reason) return preflight;
  const blockingReasons = [...new Set([...preflight.blocking_reasons, reason])];
  return {
    ...preflight,
    ok: false,
    blocking_reasons: blockingReasons,
  };
}

export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();
    await requireOrgAdmin(supabase, me.org_id);

    const gateResponse = await requireAgentOrchestration(supabase, me.org_id);
    if (gateResponse) return gateResponse;

    const parsed = createManagedAgentDeploymentSchema.safeParse(await request.json());
    if (!parsed.success) {
      return ApiErrors.badRequest(parsed.error.issues.map((issue) => issue.message).join(', '));
    }

    const service = new AgentDeploymentLifecycleService(supabase as never);
    const preflight = await service.runDeploymentPreflight({
      orgId: me.org_id,
      projectId: me.project_id,
      actorId: me.id,
      agentId: parsed.data.agent_id,
      name: parsed.data.name,
      runtime: parsed.data.runtime,
      model: parsed.data.model ?? null,
      version: parsed.data.version ?? null,
      personaId: parsed.data.persona_id ?? null,
      config: parsed.data.config,
      overwriteRoutingRules: parsed.data.overwrite_routing_rules,
    });

    const byomBlockingReason = await getByomBlockingReason(supabase, me.project_id, parsed.data.config);
    return apiSuccess({ preflight: mergeBlockingReason(preflight, byomBlockingReason) });
  } catch (error) {
    if (error instanceof DeploymentLifecycleError) {
      return ApiErrors.badRequest(error.message);
    }
    return handleApiError(error);
  }
}
