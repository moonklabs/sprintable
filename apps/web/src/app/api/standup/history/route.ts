

import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { isOssMode } from '@/lib/storage/factory';
import { getOssStandupHistory } from '@/lib/oss-standup';
import { StandupService } from '@/services/standup';

// GET /api/standup/history?project_id=X[&limit=N]
export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    if (!projectId) return ApiErrors.badRequest('project_id required');
    const limit = searchParams.get('limit') ? Number(searchParams.get('limit')) : 50;

    if (isOssMode()) {
      return apiSuccess(await getOssStandupHistory(projectId, limit));
    }

    const dbClient: any = undefined;
    const service = new StandupService(dbClient);
    const data = await service.getHistory(projectId, limit);
    return apiSuccess(data);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
