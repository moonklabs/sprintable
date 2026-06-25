import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/** POST /api/webhooks/config/[id]/test-send — 목적지 도달 테스트(합성 [TEST] 알림). BE=0a6487c6-BE(디디·731e4c0a). */
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapi(request, `/api/v2/webhooks/config/${id}/test-send`);
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}
