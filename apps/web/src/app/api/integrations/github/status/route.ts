import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// E-GHAPP Bot-L.2: GitHub App 연결상태 프록시(Bot-S BE /status). raw passthrough.
// 응답: { connected: bool } | { connected: true, account_login, account_type, repository_selection, suspended }

/** GET /api/integrations/github/status — 현 org GitHub App 연결상태(connect-prompt 구동 신호) */
export async function GET(request: Request) {
  try {
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapi(request, '/api/v2/integrations/github/status');
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}
