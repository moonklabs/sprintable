import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

function withMemberId(request: Request, memberId: string): Request {
  const url = new URL(request.url);
  url.searchParams.set('member_id', memberId);
  return new Request(url.toString(), { method: request.method, headers: request.headers, body: request.method !== 'GET' ? request.body : undefined });
}

export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapi(withMemberId(request, me.id), '/api/v2/notification-settings');
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}

export async function PUT(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapi(withMemberId(request, me.id), '/api/v2/notification-settings');
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}
