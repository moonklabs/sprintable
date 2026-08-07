import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

/**
 * POST /api/stories/{id}/reference-candidates/{candidateId}/declare — story #2358.
 * BE `POST /api/v2/stories/{id}/reference-candidates/{candidate_id}/declare`(story #2223
 * 판정)를 그대로 통과시킨다. 「이 연결이 실재하는가」만 답한다(status estimated→declared) —
 * 「무슨 종류인가」는 별도 엔드포인트(relation-kind, declare 전후 아무 때나 호출 가능).
 * ⛔IDOR 제약(BE, story #2363) — {id}는 candidate.source_id와 정확히 일치해야 한다(안
 * 맞으면 404). 이 candidate가 review 대상 story의 것이라 항상 그 story id 그대로 쓴다.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; candidateId: string }> },
): Promise<Response> {
  const { id, candidateId } = await params;
  return proxyToFastapiWithParams(
    request,
    '/api/v2/stories/[id]/reference-candidates/[candidateId]/declare',
    { id, candidateId },
  );
}
