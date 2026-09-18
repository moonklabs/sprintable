import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; publicationId: string }> };

// story #3620 — BE `POST /api/v2/organizations/{org_id}/publications/{publication_id}/
// reconcile` 위임. follow-ups/route.ts와 동형(사람 전용 게이트 없음 — BE가 사람·에이전트
// 동형으로 받는다, AC4). 409(연결 비활성/채널 미지원)도 그대로 pass-through.
export async function POST(request: Request, { params }: RouteParams) {
  const { id, publicationId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/publications/[publicationId]/reconcile', { id, publicationId },
  );
  if (!_r.ok) return _r;
  // 백엔드가 201로 생성을 알린다 — follow-ups POST와 동일 이유로 상태 코드 보존.
  return apiSuccess(await _r.json(), undefined, _r.status);
}
