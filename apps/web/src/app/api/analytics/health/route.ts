import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { AnalyticsService } from '@/services/analytics';

// GET /api/analytics/health?project_id=X
export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    if (!projectId) return ApiErrors.badRequest('project_id required');

    const service = new AnalyticsService(undefined);
    const t0 = Date.now();
    const data = await service.getProjectHealth(projectId);
    console.log(`[perf] GET /api/analytics/health project=${projectId} ${Date.now() - t0}ms`);
    return apiSuccess(data);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
