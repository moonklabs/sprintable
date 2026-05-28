import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ token: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  const { token } = await params;
  // Backend: POST /api/v2/invites/accept with body {token} (not path param)
  const headers = new Headers(request.headers);
  headers.set('Content-Type', 'application/json');
  const syntheticRequest = new Request(request.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ token }),
  });
  const _r = await proxyToFastapi(syntheticRequest, '/api/v2/invites/accept');
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  return apiSuccess(await _r.json());
}
