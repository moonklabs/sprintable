import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; campaignId: string }> };

// story 1db41045(#3457) — campaign 상세. backend/app/routers/campaigns.py::
// get_campaign_detail_endpoint 그대로 위임(소속 원문·변형·상태를 한 응답에 실어
// 준다 — 조인 축을 이 라우트가 새로 안 짠다). 조직 멤버면 휴먼·에이전트 모두 읽기
// 가능(생성만 human-only, 백엔드 그대로).
export async function GET(request: Request, { params }: RouteParams) {
  const { id, campaignId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/campaigns/[campaignId]', { id, campaignId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
