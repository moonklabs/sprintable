import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';
import { apiError, apiSuccess, ApiErrors } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import {
  AgentDeploymentLifecycleService,
  DeploymentLifecycleError,
} from '@/services/agent-deployment-lifecycle';
import { requireAgentOrchestration } from '@/lib/require-agent-orchestration';
import { patchManagedAgentDeploymentSchema } from '@/lib/managed-agent-contract';
import { isOssMode } from '@/lib/storage/factory';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: RouteParams) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Not available in OSS mode.', 501);

  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();
    await requireOrgAdmin(supabase, me.org_id);

    const gateResponse = await requireAgentOrchestration(supabase, me.org_id);
    if (gateResponse) return gateResponse;

    const { data, error } = await supabase
      .from('agent_deployments')
      .select('id, org_id, project_id, agent_id, persona_id, name, runtime, model, version, status, config, last_deployed_at, failure_code, failure_message, failure_detail, failed_at, created_at, updated_at')
      .eq('id', id)
      .eq('org_id', me.org_id)
      .eq('project_id', me.project_id)
      .maybeSingle();

    if (error) throw error;
    if (!data) return ApiErrors.notFound('Deployment not found');

    return apiSuccess(data);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: Request, { params }: RouteParams) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Not available in OSS mode.', 501);

  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();
    await requireOrgAdmin(supabase, me.org_id);

    const gateResponse = await requireAgentOrchestration(supabase, me.org_id);
    if (gateResponse) return gateResponse;

    const parsed = patchManagedAgentDeploymentSchema.safeParse(await request.json());
    if (!parsed.success) {
      return ApiErrors.badRequest(parsed.error.issues.map((issue) => issue.message).join(', '));
    }

    const service = new AgentDeploymentLifecycleService(supabase as never);
    const result = await service.transitionDeployment({
      orgId: me.org_id,
      projectId: me.project_id,
      actorId: me.id,
      deploymentId: id,
      status: parsed.data.status,
      failure: parsed.data.status === 'DEPLOY_FAILED' ? parsed.data.failure ?? null : null,
    });

    return apiSuccess(result);
  } catch (error) {
    if (error instanceof DeploymentLifecycleError) {
      return apiError(error.code, error.message, error.status, error.details);
    }
    return handleApiError(error);
  }
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Not available in OSS mode.', 501);

  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();
    await requireOrgAdmin(supabase, me.org_id);

    const gateResponse = await requireAgentOrchestration(supabase, me.org_id);
    if (gateResponse) return gateResponse;

    const service = new AgentDeploymentLifecycleService(supabase as never);
    const result = await service.terminateDeployment({
      orgId: me.org_id,
      projectId: me.project_id,
      actorId: me.id,
      deploymentId: id,
    });

    return apiSuccess(result);
  } catch (error) {
    if (error instanceof DeploymentLifecycleError) {
      return apiError(error.code, error.message, error.status, error.details);
    }
    return handleApiError(error);
  }
}
