import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// GET /api/analytics/velocity-history?project_id=X
export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const res = await proxyToFastapi(request, '/api/v2/analytics/velocity-history');
    if (!res.ok) return res;
    return apiSuccess(await res.json());
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
