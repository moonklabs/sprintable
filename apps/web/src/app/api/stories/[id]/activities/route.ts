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

    const _r = await proxyToFastapiWithParams(request, '/api/v2/stories/[id]/activities', { id });
    if (!_r.ok) return _r;
    // 긴급 정정(2026-07-28, prod 크래시): #2247이 BE list_activities에 convention-A({data,meta})를
    // 적용했는데 이 프록시가 그대로 apiSuccess(json)에 넘겨 이중포장했다(형제 comments/route.ts는
    // 이미 이 처방이 돼 있었음). 이중포장되면 소비부(story-detail-panel.tsx)의 `json.data ?? []`가
    // `json.data`(={data,meta} 객체·truthy)를 그대로 state에 넣어 `.map()`이 터진다.
    const beJson = await _r.json() as { data?: unknown; meta?: ApiMeta };
    return apiSuccess(beJson.data ?? beJson, beJson.meta);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
