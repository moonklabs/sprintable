import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

/** GET — inbox 목록 (/api/v2/inbox proxy, assignee_member_id 자동 주입) */
export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const url = new URL(request.url);
    url.searchParams.set('assignee_member_id', me.id);

    const _r = await proxyToFastapi(
      new Request(url.toString(), { method: 'GET', headers: request.headers }),
      '/api/v2/inbox',
    );
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
