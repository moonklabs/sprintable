import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

export async function GET(request: Request) {
  const _r = await proxyToFastapi(request, '/api/v2/hitl/policy');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
}

export async function PATCH(request: Request) {
  const _r = await proxyToFastapi(request, '/api/v2/hitl/policy');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
}
