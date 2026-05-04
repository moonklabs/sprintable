import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

/** GET — 내 웹훅 설정 목록 */
export async function GET(request: Request) {
  try {
    const _r = await proxyToFastapi(request, '/api/v2/webhooks/config');
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}

/** PUT — 웹훅 설정 upsert */
export async function PUT(request: Request) {
  try {
    const _r = await proxyToFastapi(request, '/api/v2/webhooks/config');
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}

/** DELETE — 웹훅 설정 삭제 */
export async function DELETE(request: Request) {
  try {
    const _r = await proxyToFastapi(request, '/api/v2/webhooks/config');
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}
