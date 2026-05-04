

import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
;
import { getOssStandupHistory } from '@/lib/oss-standup';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

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

const _r = await proxyToFastapi(request, '/api/v2/standups');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json())
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
