import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/** GET — OSS 모드에서는 null 반환 */
export async function GET(request: Request, _ctx: RouteParams) {
  const _r = await proxyToFastapi(request, '/api/v2/projects/ai-settings');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
}

/** PUT */
export async function PUT(request: Request, _ctx: RouteParams) {
  const _r = await proxyToFastapi(request, '/api/v2/projects/ai-settings');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
}

/** DELETE */
export async function DELETE(request: Request, _ctx: RouteParams) {
  const _r = await proxyToFastapi(request, '/api/v2/projects/ai-settings');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
}
