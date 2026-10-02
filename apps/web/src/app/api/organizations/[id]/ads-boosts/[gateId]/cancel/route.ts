import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; gateId: string }> };

// story #4460 — 홍보 취소. 백엔드
// backend/app/routers/ads_boost_execution.py::cancel_ads_boost_endpoint 그대로
// 위임 — 요청자 또는 owner/admin 판정은 BE가 이미 강제. 검증 로직 0.
export async function POST(request: Request, { params }: RouteParams) {
  const { id, gateId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/ads-boosts/[gateId]/cancel', { id, gateId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
