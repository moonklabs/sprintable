import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// story #3583(Phase2·마케팅운영, 페드루 PO 確定 2026-09-06) — GA4 「고객 소유」 연결
// 첫 걸음. BE가 {authorize_url}을 돌려주면 화면이 그 URL로 전체 페이지 리다이렉트
// (window.location.href) — 소셜 채널 connections의 GET 기반 BFF 리다이렉트 라우트
// (/api/oauth-channel/authorize)와 다른 결이다: BE 계약이 POST이고, 구글 콜백은
// BE가 직접 받아 우리 화면으로 리다이렉트한다(그 사이 BFF 콜백 라우트가 없다) —
// 그래서 이 라우트는 단순 pass-through일 뿐 리다이렉트 자체를 하지 않는다.
export async function POST(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/measurement-connections/ga4/authorize', { id },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json(), undefined, _r.status);
}
