import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors, type ApiMeta } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/** GET /api/pull-requests/{id}/backlinks — story #2889(S2h①). `id`는 GitHub PR 자체가
 * 아니라 canonical 링크 행(PullRequestStoryLink.id) — BE 실경로는
 * `/api/v2/integrations/github/links/{id}/backlinks`(github_integration.py, PR-story
 * 링크 도메인에 이미 있는 라우터 재사용, 신규 top-level 리소스 발명 아님). 세그먼트 이름은
 * FE `ENTITY_ROUTE_SEGMENT` 맵의 편의상 별칭일 뿐 — stories/docs 형제와 동일 convention-A
 * {data,meta} shape로 언랩한다(#2247/#2564 이중포장 재발 방지). */
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const _r = await proxyToFastapiWithParams(
      request, '/api/v2/integrations/github/links/[id]/backlinks', { id },
    );
    if (!_r.ok) return _r;
    const beJson = await _r.json() as { data?: unknown; meta?: ApiMeta };
    return apiSuccess(beJson.data ?? beJson, beJson.meta);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
