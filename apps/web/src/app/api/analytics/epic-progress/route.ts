import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { AnalyticsService } from '@/services/analytics';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

// GET /api/analytics/epic-progress?project_id=X&epic_id=Y
export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    const epicId = searchParams.get('epic_id');
    if (!projectId) return ApiErrors.badRequest('project_id required');
    if (!epicId) return ApiErrors.badRequest('epic_id required');

    const dbClient: SupabaseClient = me.type === 'agent' ? (await (await import('@/lib/supabase/admin')).createSupabaseAdminClient()) : supabase;
    const service = new AnalyticsService(dbClient);
    const data = await service.getEpicProgress(projectId, epicId);
    return apiSuccess(data);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
