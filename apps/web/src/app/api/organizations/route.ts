import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// POST /api/organizations
export async function POST(request: Request) {
  const _r = await proxyToFastapi(request, '/api/v2/organizations');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
}
