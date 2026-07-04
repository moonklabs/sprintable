import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// E-MODERN CC-FE: 커맨드 센터 ② 프로젝트 현황 + 헤더 함대 프록시. raw passthrough(Bot-L.2 #1673 동형).
// fleet.total_agents·epics·outcome·recent_changes=real / status_breakdown·risk·cycle_time·
// contribution·cost_trend={status:"pending_data"}=CC-BE.2(FE forward-compat·shape 그대로).

/** GET /api/dashboard/overview → /api/v2/command-center/overview */
export async function GET(request: Request) {
  try {
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapi(request, '/api/v2/command-center/overview');
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}
