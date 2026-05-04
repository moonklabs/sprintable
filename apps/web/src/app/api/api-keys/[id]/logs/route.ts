import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { apiSuccess } from '@/lib/api-response';

type RouteParams = { params: Promise<{ id: string }> };

/** GET /api/api-keys/[id]/logs — 키별 사용 이력 (admin/owner only) */
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
const _r = await proxyToFastapi(request, `/api/v2/api-keys/${id}/logs`);
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  return apiSuccess(await _r.json())
}
