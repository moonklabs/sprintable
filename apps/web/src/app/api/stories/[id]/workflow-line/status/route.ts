import { handleApiError } from '@/lib/api-error';
import { ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// E-DG S11: workflow-line 상태 read API thin 프록시.
// BE GET /api/v2/stories/{id}/workflow-line/status → WorkflowLineStatusResponse(read-only).
// "왜 막혔나·어디로 relay 됐나" 관측용.
// ⚠️ raw passthrough(엔벨로프 unwrap 없음) — 같은 도메인 /api/gates 와 데이터 shape 일관.
// 소비부는 BE WorkflowLineStatusResponse 를 직접 read(.data 아님). [[fastapi-proxy-envelope-boundary]]
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    return await proxyToFastapiWithParams(request, '/api/v2/stories/[id]/workflow-line/status', { id });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
