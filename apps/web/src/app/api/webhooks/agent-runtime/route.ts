import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { apiSuccess } from '@/lib/api-response';

export async function POST(request: Request) {
  const _r = await proxyToFastapi(request, '/api/v2/webhooks/agent-runtime');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
}
