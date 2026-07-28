import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors, type ApiMeta } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/** GET /api/stories/{id}/backlinks — story #2299(E-CONNECT): 이 스토리를 가리키는 것들
 * (chat_message/doc source) 목록 + still_exists(끊어짐 사실). BE(list_entity_backlinks)는
 * convention-A({data,meta}) — activities/route.ts의 이중포장 사고(#2247/#2564)와 같은 자리라
 * 처음부터 raw json.data ?? json 언랩 패턴으로 짓는다(재발 금지). */
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const _r = await proxyToFastapiWithParams(request, '/api/v2/stories/[id]/backlinks', { id });
    if (!_r.ok) return _r;
    const beJson = await _r.json() as { data?: unknown; meta?: ApiMeta };
    return apiSuccess(beJson.data ?? beJson, beJson.meta);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
