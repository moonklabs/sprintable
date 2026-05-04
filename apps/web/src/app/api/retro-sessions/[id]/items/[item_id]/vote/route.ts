import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
;
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';
import { voteOssRetroItem } from '@/lib/oss-retro';

type RouteParams = { params: Promise<{ id: string; item_id: string }> };

// POST /api/retro-sessions/:id/items/:item_id/vote
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id, item_id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

const _r = await proxyToFastapiWithParams(request, '/api/v2/retros/[id]/items/[item_id]/vote', { id, item_id });
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json())
  } catch (err: unknown) {
    const e = err as Error & { code?: string };
    if (e.code === 'CONFLICT') return apiError('CONFLICT', e.message, 409);
    return handleApiError(err);
  }
}
