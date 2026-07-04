import { handleApiError } from '@/lib/api-error';
import { ApiErrors } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// E-DG S11 ①: workflow-line 상태 배치 read 프록시(보드 카드 badge용).
// BE GET /api/v2/stories/workflow-line/status?ids=<csv> → list[LineStatusSummary](active-only·1쿼리·N+1 0·max200).
// ⚠️ batch-first 라우팅: 정적 'workflow-line' 세그먼트가 [id] 보다 우선 매칭(BE 라우트 순서와 동일).
// raw passthrough — 같은 도메인 /api/gates·per-story status 와 데이터 shape 일관(.data 아님).
// query(?ids=)는 proxyToFastapi 가 url.search 로 자동 forward(중복 append 금지).
export async function GET(request: Request) {
  try {
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    return await proxyToFastapi(request, '/api/v2/stories/workflow-line/status');
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
