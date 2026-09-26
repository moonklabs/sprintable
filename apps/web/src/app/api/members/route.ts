import { handleApiError } from '@/lib/api-error';
import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { withRouteTiming } from '@/lib/server-timing';

// GET /api/members?project_id=X
// Canonical SSOT 멤버 소스 — FastAPI /api/v2/members 로 프록시한다.
// (휴먼: org_members + project_access grant 모델 / 에이전트: team_members type=agent)
// team_members 뷰 기반 /api/v2/team-members 와 달리 grant 휴먼·owner/admin 누락이 없다.
// story #4299 AC2 — 라우트 전체 계측(합계 · bff_pre · 인증 /me 포함 모든 백엔드 호출 · dev 전용 · 꺼지면 그대로 호출).
export const GET = withRouteTiming('members', async (request: Request) => {
  try {
    const res = await proxyToFastapi(request, '/api/v2/members');
    if (!res.ok) return res;
    const data: unknown = await res.json();
    return apiSuccess(data);
  } catch (err: unknown) {
    return handleApiError(err);
  }
});
