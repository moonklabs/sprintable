import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';
import { BFF_BACKEND_EXTERNAL_CHAIN_TIMEOUT_MS } from '@/lib/backend-signal';

type RouteParams = { params: Promise<{ id: string; channel: string }> };

// story #3376, PR#3736 실 계약 — owner 전용, body={code,state}. 이 라우트를 직접 부르는 건
// 브라우저가 아니라 app/api/oauth-channel/callback/[channel]/route.ts(Meta 리다이렉트를
// 받는 GET 엔드포인트)다 — BE가 state의 org_id를 검증하므로 이 BFF는 그대로 릴레이만 한다.
export async function POST(request: Request, { params }: RouteParams) {
  const { id, channel } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/channel-connections/[channel]/callback', { id, channel },
    {
      // 백엔드는 외부 호출을 잇달아(최대 3 × 15초 = 45초 · channel_connections.py:746,812,883) — 직접 콜백 라우트와 같은 60초.
      // story #4320(까디르 QA ①③) — OAuth 코드를 소비한다(끊으면 연결은 됐는데 결과를 못 받음) — 브라우저가 끊어도 끝까지 간다 · 시간 제한만.
      timeLimitOnly: true,
      timeoutMs: BFF_BACKEND_EXTERNAL_CHAIN_TIMEOUT_MS,
    },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
