import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; gateId: string }> };

// story #4412 — «it is already in my ad account»: backend/app/routers/ads_boost_execution.py::adopt_existing_ads_boost_endpoint
// as is (human only is enforced by the BE). No validation here.
export async function POST(request: Request, { params }: RouteParams) {
  const { id, gateId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/ads-boosts/[gateId]/adopt-existing', { id, gateId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
