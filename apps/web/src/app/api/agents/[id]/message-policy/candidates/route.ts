import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/** GET /api/agents/[id]/message-policy/candidates — allowlist 추가 피커 후보 로스터.
 * story #3231 4라운드(카디르 QA) — 이 위 message-policy 엔드포인트들과 동일 게이트
 * (assert_agent_owner=생성자 OR org admin/owner)로 인가한다. org-members roster(org
 * admin 전용)는 안 건드림. */
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapi(request, `/api/v2/agents/${id}/message-policy/candidates`);
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}
