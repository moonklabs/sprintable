import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';
import { apiError, apiSuccess, ApiErrors } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import {
  AgentDeploymentLifecycleService,
  DeploymentLifecycleError,
} from '@/services/agent-deployment-lifecycle';
import { buildDeploymentCards } from '@/services/agent-dashboard';
import { requireAgentOrchestration } from '@/lib/require-agent-orchestration';
import { createManagedAgentDeploymentSchema } from '@/lib/managed-agent-contract';
import { isOssMode } from '@/lib/storage/factory';
import {
  getProjectAiSettingsWithIntegration,
  hasProjectAiCredential,
  matchesProjectAiCredentialProvider,
  resolveProjectAiCredentialProvider,
} from '@/lib/llm/project-ai-settings';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClientType = any;

export async function GET() {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Not available in OSS mode.', 501);

  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();
    await requireOrgAdmin(supabase, me.org_id);

    const gateResponse = await requireAgentOrchestration(supabase, me.org_id);
    if (gateResponse) return gateResponse;

    const cards = await buildDeploymentCards(supabase, me.org_id, me.project_id, me.id);
    return apiSuccess(cards);
  } catch (error) {
    return handleApiError(error);
  }
}

async function assertByomDeploymentAllowed(supabase: SupabaseClientType, projectId: string, input: { llm_mode: string; provider: string }) {
  if (input.llm_mode !== 'byom') return;

  const aiCredentialState = await getProjectAiSettingsWithIntegration(supabase as never, projectId);
  if (!hasProjectAiCredential(aiCredentialState)) {
    throw new DeploymentLifecycleError(
      'BYOM_CREDENTIAL_MISSING',
      409,
      `Project AI settings do not have a stored BYOM credential for provider ${input.provider}`,
    );
  }

  if (!matchesProjectAiCredentialProvider(aiCredentialState, input.provider)) {
    const credentialProvider = resolveProjectAiCredentialProvider(aiCredentialState);
    throw new DeploymentLifecycleError(
      'BYOM_PROVIDER_MISMATCH',
      409,
      credentialProvider
        ? `Project AI settings are configured for provider ${credentialProvider}; BYOM deployments must use the same provider`
        : `Project AI settings provider does not match ${input.provider}`,
    );
  }
}

export async function POST(request: Request) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Not available in OSS mode.', 501);

  try {
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

    await assertByomDeploymentAllowed(supabase, me.project_id, parsed.data.config);

    const service = new AgentDeploymentLifecycleService(supabase as never);
    const result = await service.createDeployment({
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

    return apiSuccess(result, undefined, 202);
  } catch (error) {
    if (error instanceof DeploymentLifecycleError) {
      return apiError(error.code, error.message, error.status, error.details);
    }
    return handleApiError(error);
  }
}
