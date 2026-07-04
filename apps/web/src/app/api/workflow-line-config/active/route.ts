import { ApiErrors } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// E-DG S29 follow-up: 좌-pane 데이터소스 — 현 active published 라인 config(steps/gates) 조회 프록시(admin·#1637).
// BE GET /api/v2/workflow-line-config/active?entity_type=&project_id= → {has_active, definition_id?, config{steps[]}}.
// proxyToFastapi가 url.search(entity_type/project_id) 자동 전달. raw passthrough(workflow-line 도메인 일관).
export async function GET(request: Request) {
  try {
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    return await proxyToFastapi(request, '/api/v2/workflow-line-config/active');
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
