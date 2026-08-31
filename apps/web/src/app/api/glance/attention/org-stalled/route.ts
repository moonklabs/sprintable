import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// GET /api/glance/attention/org-stalled — story #3153(93b076c8 후속) «침묵의 정체» org-wide
// 커버리지. BE `/api/v2/glance/attention/org-stalled`로 프록시(project_id 쿼리파라미터 없음 —
// 접근 가능한 전 프로젝트를 BE가 순회). project별 접근권 가드는 BE(accessible_project_ids_in_org)가 수행.
export async function GET(request: Request) {
  try {
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const res = await proxyToFastapi(request, '/api/v2/glance/attention/org-stalled');
    if (!res.ok) return res;
    return apiSuccess(await res.json());
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
