import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/** POST /api/projects/:id/invitations */
export async function POST(request: Request, _ctx: RouteParams) {
  const _r = await proxyToFastapi(request, '/api/v2/projects/invitations');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
}
