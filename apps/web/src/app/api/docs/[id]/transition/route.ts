import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// E-DG S28: doc decision lifecycle 전이 프록시 — 재상신(draft→pending·gate 재진입)·수정 진입(denied→draft) 등.
// BE POST /api/v2/docs/{id}/transition {status}. caller는 BE가 auth 컨텍스트서 강제(body 신뢰X·RC① 패턴).
// doc 도메인 envelope 일관(apiSuccess·{data}·revisions/comments 동형).
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const _r = await proxyToFastapiWithParams(request, '/api/v2/docs/[id]/transition', { id });
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}
