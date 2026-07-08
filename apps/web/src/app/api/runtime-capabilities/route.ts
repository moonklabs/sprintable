import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

/**
 * GET /api/runtime-capabilities — E-RECRUIT S6: 지원 런타임 + capability 노출(honest matrix SSOT).
 * 404(BE `GET /api/v2/runtime-capabilities` 미배포)는 그대로 전달 — 소비부(recruiter-client)가
 * 폴백 처리한다(에러를 여기서 감추지 않음).
 */
export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapi(request, '/api/v2/runtime-capabilities');
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}
