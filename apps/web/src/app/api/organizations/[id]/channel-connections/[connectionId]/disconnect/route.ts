import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; connectionId: string }> };

// story #3376, 그라운딩 §10-1/§10-3 — owner 전용. 파괴적 행동(§6 "예약된 것을 함께
// 죽인다") — 확인 다이얼로그는 화면 몫, 이 라우트는 BE 응답을 그대로 전달만 한다.
export async function POST(request: Request, { params }: RouteParams) {
  const { id, connectionId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/channel-connections/[connectionId]/disconnect', { id, connectionId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
