import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// story #3806 PR 7(페드루 PO 리뷰 2026-09-11 14:16Z 실측 — 404, BFF 라우트 부재) —
// facebook/select/route.ts와 동형. BE 라우트는 `POST /{org_id}/channel-connections/
// meta-ads/select`로 **리터럴 고정**이다(meta_ads·ads_sandbox 둘 다 이 한 경로로
// select를 보낸다 — pending.channel로 어느 채널인지 되찾는다, channel_connections.py
// ::meta_ads_select_account_endpoint 실측). facebook/select와 별도 엔드포인트인
// 이유는 candidateId 축이 다르기 때문(account_id vs page_id, 계정별 토큰이 없어
// pending에 저장된 장기 유저 토큰을 그대로 쓴다).
export async function POST(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/channel-connections/meta-ads/select', { id },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json(), undefined, _r.status);
}
