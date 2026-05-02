import { handleApiError } from '@/lib/api-error';
import { ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { isOssMode } from '@/lib/storage/factory';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// GET /api/dashboard?member_id=X[&project_id=X]
export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    if (isOssMode()) {
      const { apiSuccess } = await import('@/lib/api-response');
      return apiSuccess({ my_stories: [], assigned_stories: [], my_tasks: [], open_memos: [] });
    }

    return proxyToFastapi(request, '/api/v2/dashboard');
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
