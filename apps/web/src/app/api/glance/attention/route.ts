import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { withRouteTiming } from '@/lib/server-timing';

// GET /api/glance/attention?project_id=X — 현 프로젝트 예외 스트림(gate_pending·blocked·merge_ready).
// BE `/api/v2/glance/attention`(#2097)로 프록시. project-scope 가드는 BE(has_project_access·404)가 수행.
// story #4299 AC2 — 라우트 전체 계측(합계 · bff_pre · 인증 /me 포함 모든 백엔드 호출 · dev 전용 · 꺼지면 그대로 호출).
export const GET = withRouteTiming('glance-attention', async (request: Request) => {
  try {
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const res = await proxyToFastapi(request, '/api/v2/glance/attention');
    if (!res.ok) return res;
    return apiSuccess(await res.json());
  } catch (err: unknown) {
    return handleApiError(err);
  }
});
