import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #3831(UX-v3·FE 3·오늘) 프록시. raw passthrough(query 그대로 전달 — tz 포함,
// story #3823 BE 계약대로) — my-actions/route.ts와 동형 관례.

/** GET /api/today → /api/v2/today */
export async function GET(request: Request) {
  try {
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapi(request, '/api/v2/today');
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}
