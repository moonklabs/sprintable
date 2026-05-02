import { apiSuccess } from '@/lib/api-response';

import { proxyToFastapi } from '@/lib/fastapi-proxy';

// POST /api/agent-runs
export async function POST(request: Request) {
  const _r = await proxyToFastapi(request, '/api/v2/agent-runs');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
}

// GET /api/agent-runs?project_id=X&limit=N
export async function GET(request: Request) {
  const _r = await proxyToFastapi(request, '/api/v2/agent-runs');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
}
