import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// GET /api/glance/hero?story_id=X — 현재 에픽 활성 story의 ProofCapsule envelope.
// BE `/api/v2/glance/hero`(#2099)로 프록시. project-scope 가드는 BE(has_project_access·404)가 수행.
export async function GET(request: Request) {
  try {
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const res = await proxyToFastapi(request, '/api/v2/glance/hero');
    if (!res.ok) return res;
    return apiSuccess(await res.json());
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
