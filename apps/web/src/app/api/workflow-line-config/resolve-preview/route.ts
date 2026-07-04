import { ApiErrors } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// E-DG S29: workflow line policy dry-run resolve-preview 프록시(admin·라인 config publish 前 시뮬레이션).
// BE POST /api/v2/workflow-line-config/resolve-preview {entity_type,entity_id,from_status?,to_status,actor?,project_id?}
//   → 3축 {routing_path, gates, trust_branch}. raw passthrough(workflow-line 도메인 일관·소비부서 직접 read).
export async function POST(request: Request) {
  try {
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    return await proxyToFastapi(request, '/api/v2/workflow-line-config/resolve-preview');
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
