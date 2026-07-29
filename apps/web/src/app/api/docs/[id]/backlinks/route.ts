import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors, type ApiMeta } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/** GET /api/docs/{id}/backlinks — 두 번째 backlinks 소비자(첫 자리는 stories/[id]/backlinks,
 * story #2299). BE(list_entity_backlinks)는 docs/stories 둘 다 같은 함수·같은 convention-A
 * shape({data,meta}) — 그래서 이 프록시도 형제(stories/[id]/backlinks/route.ts)와 완전히
 * 동형으로 짓는다(raw json.data ?? json 언랩, #2247/#2564 이중포장 재발 방지). */
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const _r = await proxyToFastapiWithParams(request, '/api/v2/docs/[id]/backlinks', { id });
    if (!_r.ok) return _r;
    const beJson = await _r.json() as { data?: unknown; meta?: ApiMeta };
    return apiSuccess(beJson.data ?? beJson, beJson.meta);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
