import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// GET /api/activity-stream?project_id=X&actor_id=&verb=&object_type=&object_id=&since=&until=&after_seq=&limit=
// L1-FE-1 Team Activity read surface — canonical 활동 스트림(activity_seq ASC cursor). thin proxy
// (activity-logs 패턴): BE raw 응답을 apiSuccess {data} 엔벨로프로 래핑. org-scope·AC④(recipient
// 명단 미노출)·delivery status 미포함은 BE에서 강제 — FE는 표시만(개수=recipient_ids.length).
export async function GET(request: Request) {
  try {
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const res = await proxyToFastapi(request, '/api/v2/activity-stream');
    if (!res.ok) return res;
    return apiSuccess(await res.json());
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
