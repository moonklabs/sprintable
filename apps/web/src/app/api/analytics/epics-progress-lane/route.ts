import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// GET /api/analytics/epics-progress-lane?project_id= — story #2224 좌 레인 4분류(막힘·대기·
// 진행·멈춤·그외) + 시간축 3분류(past_cnt·now_cnt·upcoming_cnt, #2686 급추가). BE
// `/api/v2/analytics/epics-progress-lane`(#2672+#2686)로 프록시 — glance/attention·
// epic-flow-nodes와 같은 proxyToFastapi 패턴.
export async function GET(request: Request) {
  try {
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const res = await proxyToFastapi(request, '/api/v2/analytics/epics-progress-lane');
    if (!res.ok) return res;
    return apiSuccess(await res.json());
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
