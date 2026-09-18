import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// story #3583(페드루 PO 確定 2026-09-06) — body {property_id} pass-through.
export async function POST(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/measurement-connections/ga4/select', { id },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json(), undefined, _r.status);
}
