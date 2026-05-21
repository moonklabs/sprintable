import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ token: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  const { token } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/invites/[token]', { token });
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  return apiSuccess(await _r.json());
}
