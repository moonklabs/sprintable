import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

export async function GET(request: Request) {
  const _r = await proxyToFastapi(request, '/api/v2/agent-deployments');
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  const json = await _r.json();
  return apiSuccess(json.data, json.meta ?? undefined);
}

export async function POST(request: Request) {
  const _r = await proxyToFastapi(request, '/api/v2/agent-deployments');
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  const json = await _r.json();
  return apiSuccess(json.data, json.meta ?? undefined, _r.status);
}
