import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #3260 Phase 2 — 위젯이 Support Gateway(별도 Cloud Run 서비스)를 직접 호출하기
// 전에 필요한 org-스코프 위임 토큰 발급. 본체 backend POST /api/v2/support/session-token
// (backend/app/routers/support_gateway_token.py) → { token, expires_in }. 그 이후의 실제
// Gateway 호출(POST /api/v1/sessions 등)은 이 라우트를 거치지 않고 브라우저가 Gateway
// origin으로 직접 나간다(apps/web/src/lib/support-widget/gateway-client.ts) — 이 라우트는
// "이 앱 세션(쿠키) → Gateway가 신뢰하는 위임 토큰" 교환 지점 하나뿐.
export async function POST(request: Request) {
  const _r = await proxyToFastapi(request, '/api/v2/support/session-token');
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json(), undefined, _r.status);
}
