import { createSupabaseServerClient } from '@/lib/supabase/server';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';
import { summarizeMonthlyUsageRows, validateUsageMonth } from '@/services/monthly-agent-usage';
import { ensureUsageProjectInOrg, loadMonthlyAgentUsageRows } from '@/services/monthly-agent-usage-dashboard';

export async function GET(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();

    const url = new URL(request.url);
    const orgId = url.searchParams.get('org_id');
    if (!orgId) return ApiErrors.badRequest('org_id is required');
    if (orgId !== me.org_id) return ApiErrors.forbidden();

    await requireOrgAdmin(supabase, me.org_id);

    const monthValidation = validateUsageMonth(url.searchParams.get('month'));
    if (!monthValidation.ok) return ApiErrors.badRequest(monthValidation.message);

    const projectId = url.searchParams.get('project_id');
    const project = projectId
      ? await ensureUsageProjectInOrg(supabase as never, orgId, projectId).catch((error: unknown) => {
        if (error instanceof Error && error.message === 'project_id must belong to the same organization') {
          return '__INVALID_PROJECT__' as const;
        }
        throw error;
      })
      : null;

    if (project === '__INVALID_PROJECT__') {
      return ApiErrors.badRequest('project_id must belong to the same organization');
    }

    const rows = await loadMonthlyAgentUsageRows(supabase as never, {
      orgId,
      month: monthValidation.month,
      projectId,
    });

    return apiSuccess({
      org_id: orgId,
      month: monthValidation.month,
      project_id: projectId,
      project_name: project?.name ?? null,
      ...summarizeMonthlyUsageRows(rows),
    });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
