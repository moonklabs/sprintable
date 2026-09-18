import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; commentId: string }> };

// story #3805(Phase3·3-1·PR 2[FE]) — 상태/배정 변경. triage_status 생략=유지·명시
// null=해제(BE model_fields_set 관례) 그대로 body를 통과시킨다(BFF 검증·조립 0).
export async function PATCH(request: Request, { params }: RouteParams) {
  const { id, commentId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/engagement/items/[commentId]', { id, commentId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
