import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
;
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// GET /api/sprints/:id/checkin?date=YYYY-MM-DD
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const _r = await proxyToFastapiWithParams(request, '/api/v2/sprints/[id]/checkin', { id });
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
