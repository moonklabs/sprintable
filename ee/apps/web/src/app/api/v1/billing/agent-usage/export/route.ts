import { createSupabaseServerClient } from '@/lib/supabase/server';
import { handleApiError } from '@/lib/api-error';
import { ApiErrors } from '@/lib/api-response';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';
import {
  buildMonthlyUsageBreakdownRows,
  serializeMonthlyUsageBreakdownCsv,
  type MonthlyAgentUsageBreakdownGroup,
  validateUsageMonth,
} from '@/services/monthly-agent-usage';
import { ensureUsageProjectInOrg, loadMonthlyAgentUsageRows, loadMonthlyUsageLookupMaps } from '@/services/monthly-agent-usage-dashboard';

export async function GET(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();

    await requireOrgAdmin(supabase, me.org_id);

    const url = new URL(request.url);
    const monthValidation = validateUsageMonth(url.searchParams.get('month'));
    if (!monthValidation.ok) return ApiErrors.badRequest(monthValidation.message);

    const groupBy = url.searchParams.get('group_by');
    if (groupBy !== 'project' && groupBy !== 'agent' && groupBy !== 'model') {
      return ApiErrors.badRequest('group_by must be project, agent, or model');
    }

    const projectId = url.searchParams.get('project_id');
    const project = projectId
      ? await ensureUsageProjectInOrg(supabase as never, me.org_id, projectId).catch((error: unknown) => {
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
      orgId: me.org_id,
      month: monthValidation.month,
      projectId,
    });
    const lookup = await loadMonthlyUsageLookupMaps(supabase as never, rows);
    const csv = serializeMonthlyUsageBreakdownCsv({
      month: monthValidation.month,
      groupBy: groupBy as MonthlyAgentUsageBreakdownGroup,
      projectLabel: project?.name ?? 'All projects',
      rows: buildMonthlyUsageBreakdownRows(rows, groupBy as MonthlyAgentUsageBreakdownGroup, lookup),
    });

    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="agent-usage-${monthValidation.month}-${groupBy}.csv"`,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
