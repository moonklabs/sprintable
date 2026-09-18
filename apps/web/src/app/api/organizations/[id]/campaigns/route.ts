import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// story 1db41045(#3457) — campaign 휴먼 표면의 BFF. 백엔드
// backend/app/routers/campaigns.py::post_campaign / list_campaigns_endpoint를 그대로
// 위임할 뿐 검증 로직 0(site-posts/drafts/route.ts와 동형 패턴).
//
// GET  — 조직의 campaign 목록(created_at desc). 페드루 PO 確定(2026-09-04 17:01Z) —
//        디디 BE 소형 후속(list 엔드포인트 신설, CampaignResponse 재사용·GET/{id}와
//        같은 권한 폭)이 이 라우트가 여는 시점의 base에 이미 있어야 한다(그 前엔 이
//        route.ts는 만들되 PR을 열지 않는다).
// POST — campaign 생성. 백엔드 _require_human이 휴먼 전용을 이미 강제한다(에이전트
//        403 CAMPAIGN_CREATE_HUMAN_ONLY) — 이 BFF는 role을 더 좁히지 않는다(페드루
//        PO 정정: 보임=성질·활성=성질∧권한이고 권한의 정본은 BE).
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/organizations/[id]/campaigns', { id });
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}

export async function POST(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/organizations/[id]/campaigns', { id });
  if (!_r.ok) return _r;
  // 백엔드가 201로 생성을 알린다(campaigns.py::post_campaign status_code=201) —
  // apiSuccess 기본값(200)에 묻히면 소비부가 상태 코드로 "새로 만들어짐"을 못 구분한다.
  return apiSuccess(await _r.json(), undefined, _r.status);
}
