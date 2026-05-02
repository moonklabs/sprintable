import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; serverKey: string }> };

export async function PUT(request: Request, _ctx: RouteParams) {
  const _r = await proxyToFastapi(request, '/api/v2/projects/mcp-connections');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
}

export async function DELETE(request: Request, _ctx: RouteParams) {
  const _r = await proxyToFastapi(request, '/api/v2/projects/mcp-connections');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
}
