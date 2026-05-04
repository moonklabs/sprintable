import { handleApiError } from '@/lib/api-error';
import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

/** GET — 조직 프로젝트 목록 */
export async function GET(request: Request) {
  try {
    const _r = await proxyToFastapi(request, '/api/v2/projects');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

/** POST — 프로젝트 생성 */
export async function POST(request: Request) {
  try {
    const _r = await proxyToFastapi(request, '/api/v2/projects');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
