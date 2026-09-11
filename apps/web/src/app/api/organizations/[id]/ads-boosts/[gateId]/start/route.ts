import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; gateId: string }> };

// story #3806(Phase3·3-2 PR5) — 승인된 홍보(ads_boost) 실행. 백엔드
// backend/app/routers/ads_boost_execution.py::start_ads_boost_endpoint 그대로
// 위임 — 휴먼 전용은 BE가 이미 강제. 검증 로직 0.
export async function POST(request: Request, { params }: RouteParams) {
  const { id, gateId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/ads-boosts/[gateId]/start', { id, gateId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
