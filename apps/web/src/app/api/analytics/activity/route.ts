import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { AnalyticsService } from '@/services/analytics';

// GET /api/analytics/activity?project_id=X&limit=N
export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    if (!projectId) return ApiErrors.badRequest('project_id required');
    const limit = searchParams.get('limit');

    const service = new AnalyticsService(undefined);
    const data = await service.getRecentActivity(projectId, limit ? Number(limit) : undefined);
    return apiSuccess(data);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
