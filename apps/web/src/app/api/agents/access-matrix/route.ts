import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

/**
 * GET /api/agents/access-matrix — 에이전트 관리 IA Phase 2(story da4c6b2d) 접근권한 매트릭스 시드.
 * BE(`/api/v2/agents/access-matrix`, PR #1948)는 raw 배열 `[{agent_member_id, project_id, record_id}]`을
 * 반환한다(`{data}` 래핑 없음) — 이 프록시도 `/api/v2/projects/[id]/access` 등 다른 access 엔드포인트와
 * 동일하게 `apiSuccess()`로 감싸 FE 소비 형상을 `{data: [...]}`로 통일한다.
 */
export async function GET(request: Request) {
  try {
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapi(request, '/api/v2/agents/access-matrix');
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}
