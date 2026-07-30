import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// GET /api/analytics/epic-flow-nodes?project_id=&epic_id=&upcoming_limit= — 결함 fix(2026-07-30):
// flow-epic-nodes.tsx가 이 프록시 라우트 없이 브라우저에서 백엔드 원본 경로
// `/api/v2/analytics/epic-flow-nodes`를 직접 fetch해 401(Missing Authorization header)로
// 라이브 픽셀 검증 중 실패했다 — 다른 모든 엔드포인트(glance/attention 등)와 같은
// proxyToFastapi 패턴으로 인증 토큰을 실어 나른다(#2224 후속, PR#2679 계약).
export async function GET(request: Request) {
  try {
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const res = await proxyToFastapi(request, '/api/v2/analytics/epic-flow-nodes');
    if (!res.ok) return res;
    return apiSuccess(await res.json());
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
