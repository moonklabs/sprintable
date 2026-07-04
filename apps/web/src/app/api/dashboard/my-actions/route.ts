import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// E-MODERN CC-FE: 커맨드 센터 ① 내 할 일 프록시. raw passthrough(body/query strip 0·Bot-L.2 #1673 동형).
// action_queue=caller member-private·attention=org 자동감지. BE가 danger>warn>info 정렬(FE 재정렬 X).

/** GET /api/dashboard/my-actions → /api/v2/command-center/my-actions */
export async function GET(request: Request) {
  try {
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapi(request, '/api/v2/command-center/my-actions');
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}
