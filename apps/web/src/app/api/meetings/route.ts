import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { isOssMode } from '@/lib/storage/factory';
import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { checkResourceLimit } from '@/lib/check-feature';

/** GET — 회의록 목록 */
export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    if (isOssMode()) return apiSuccess([]);

    const _r = await proxyToFastapi(request, '/api/v2/meetings');
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}

/** POST — 회의록 생성 */
export async function POST(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);


    // AC8: Feature gating (SaaS only)
    const check = await checkResourceLimit(undefined, me.org_id, 'max_meetings', 'meetings');
    if (!check.allowed) return apiError('UPGRADE_REQUIRED', check.reason ?? 'Meeting limit reached', 403);

    const _r = await proxyToFastapi(request, '/api/v2/meetings');
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json(), undefined, 201);
  } catch (err: unknown) { return handleApiError(err); }
}
