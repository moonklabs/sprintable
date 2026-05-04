import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors, apiError } from '@/lib/api-response';
;
import { getAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

export async function GET(request: Request) {
  try {
    const _r = await proxyToFastapi(request, '/api/v2/agent-personas');
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}

export async function POST(request: Request) {
  try {
    const _r = await proxyToFastapi(request, '/api/v2/agent-personas');
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}
