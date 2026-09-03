import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; channel: string }> };

// story #3376, PR#3736 실 계약 — owner 전용, body={code,state}. 이 라우트를 직접 부르는 건
// 브라우저가 아니라 app/api/oauth-channel/callback/[channel]/route.ts(Meta 리다이렉트를
// 받는 GET 엔드포인트)다 — BE가 state의 org_id를 검증하므로 이 BFF는 그대로 릴레이만 한다.
export async function POST(request: Request, { params }: RouteParams) {
  const { id, channel } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/channel-connections/[channel]/callback', { id, channel },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
