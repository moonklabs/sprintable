import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; connectionId: string }> };

// story #3376, 그라운딩 §10-1/§10-3 — human(member 이상, owner 제한 없음). provider
// 경량 호출 결과만 반환({ok, account?, error?}) — 토큰 자체는 이 왕복에 안 실린다.
export async function POST(request: Request, { params }: RouteParams) {
  const { id, connectionId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/channel-connections/[connectionId]/test', { id, connectionId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
