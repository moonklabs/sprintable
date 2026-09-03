import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; channel: string }> };

// story #3376, 그라운딩 §10-1/§10-3 — owner 전용. FE는 body 없이 호출한다(BE가 state+PKCE
// 전권 — Phase 0 S2의 "role_id를 FE가 지어내면 안 된다" 판단과 동일 축, 서버가 만드는
// 값을 클라이언트가 재현하지 않는다). 응답 {url, state} — url로 그대로 리다이렉트.
export async function POST(request: Request, { params }: RouteParams) {
  const { id, channel } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/channel-connections/[channel]/authorize', { id, channel },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
