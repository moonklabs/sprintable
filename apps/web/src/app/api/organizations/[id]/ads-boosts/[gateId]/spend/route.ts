import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; gateId: string }> };

// story #3806(Phase3·3-2 PR5) — 「승인 예산 대비 지출」 조회(성과 보드 「광고비」 분리
// 칸의 데이터 원천). 백엔드 backend/app/routers/ads_boost_execution.py::
// get_ads_boost_spend_endpoint 그대로 위임 — 읽기 전용(BE도 human-only 아님).
export async function GET(request: Request, { params }: RouteParams) {
  const { id, gateId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/ads-boosts/[gateId]/spend', { id, gateId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
