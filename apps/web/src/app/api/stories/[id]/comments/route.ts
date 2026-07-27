import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors, type ApiMeta } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const _r = await proxyToFastapiWithParams(request, '/api/v2/stories/[id]/comments', { id });
    if (!_r.ok) return _r;
    // story #2230: BE가 {data,meta}(#2231 규약 A)를 낸다 — 그대로 apiSuccess(json)에 넘기면
    // 통째로 다시 data 필드에 얹혀 이중포장된다(오늘 mockups에서 본 것과 동형). data/meta를
    // 풀어서 넘긴다.
    const beJson = await _r.json() as { data?: unknown; meta?: ApiMeta };
    return apiSuccess(beJson.data ?? beJson, beJson.meta);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const _r = await proxyToFastapiWithParams(request, '/api/v2/stories/[id]/comments', { id });
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
