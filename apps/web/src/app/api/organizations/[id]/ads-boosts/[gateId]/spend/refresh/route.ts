import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; gateId: string }> };

// story #3806(Phase3·3-2 PR 12) — 「광고비 다시 수집」. 백엔드
// backend/app/routers/ads_boost_execution.py::refresh_ads_boost_spend_endpoint
// 그대로 위임 — 429 ADS_SPEND_REFRESH_RATE_LIMITED(Retry-After 헤더+메시지, 이미
// fastapi-proxy.ts 공용 허용목록에 있음, comments/refresh 선례)·409
// ADS_BOOST_NOT_STARTED·403 ADS_BOOST_EXECUTE_HUMAN_ONLY·404
// ADS_BOOST_GATE_NOT_FOUND까지 전부 그대로 pass-through. 검증 로직 0.
export async function POST(request: Request, { params }: RouteParams) {
  const { id, gateId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/ads-boosts/[gateId]/spend/refresh', { id, gateId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
