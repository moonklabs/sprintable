import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; publicationId: string }> };

// story #3806(Phase3·3-2 PR5) — 승인 발행물에서 「홍보」(boost) 요청. 백엔드
// backend/app/routers/ads_boost.py::create_ads_boost_endpoint 그대로 위임 — 휴먼
// 전용은 BE가 이미 강제(에이전트 403, 그라운딩 AC4). 검증 로직 0.
export async function POST(request: Request, { params }: RouteParams) {
  const { id, publicationId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/publications/[publicationId]/boosts', { id, publicationId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
