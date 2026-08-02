import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

/**
 * POST /api/stories/{id}/reference-candidates/{candidateId}/reject — story #2357.
 * BE `POST /api/v2/stories/{id}/reference-candidates/{candidate_id}/reject`(story #2221
 * 후속)를 그대로 통과시킨다. `DELETE .../reference-candidates/{candidateId}`(undeclare)와는
 * 다른 행위 — 이건 (source,target) 쌍을 `rejected_relations`에 영속 기록해 다음 산문
 * 임포트에서도 걸러지게 한다. reason은 이 판(#2357) 스코프 밖(PO 지시 — 사유 입력은 다음
 * 판) — 항상 빈 body로 보낸다.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; candidateId: string }> },
): Promise<Response> {
  const { id, candidateId } = await params;
  return proxyToFastapiWithParams(
    request,
    '/api/v2/stories/[id]/reference-candidates/[candidateId]/reject',
    { id, candidateId },
  );
}
