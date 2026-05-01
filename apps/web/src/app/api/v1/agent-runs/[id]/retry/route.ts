import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';
import { apiError, apiSuccess, ApiErrors } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { requireAgentOrchestration } from '@/lib/require-agent-orchestration';
import { AgentRetryService } from '@/services/agent-retry';
import { canManuallyRetryRun } from '@/services/agent-run-history';
import { isOssMode } from '@/lib/storage/factory';

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: RouteParams) {
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

    // verify run belongs to this org/project and is failed
    const { data: run, error } = await supabase
      .from('agent_runs')
      .select('id, status, org_id, project_id, failure_disposition, retry_count, max_retries, next_retry_at, last_error_code, error_message')
      .eq('id', id)
      .eq('org_id', me.org_id)
      .eq('project_id', me.project_id)
      .single();

    if (error || !run) return ApiErrors.notFound('Agent run not found');
    if (run.status !== 'failed') {
      return ApiErrors.badRequest('Only failed runs can be retried');
    }
    if (!canManuallyRetryRun(run)) {
      return ApiErrors.badRequest('This run cannot be retried manually in its current state');
    }

    const retryService = new AgentRetryService(supabase as never);
    const result = await retryService.executeRetry(id);

    return apiSuccess(result, undefined, 202);
  } catch (err) {
    return handleApiError(err);
  }
}
