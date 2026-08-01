import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

/**
 * DELETE /api/stories/{id}/reference-candidates/{candidateId} — story #2353 후속
 * (2026-07-31). BE `DELETE /api/v2/stories/{id}/reference-candidates/{candidate_id}`
 * (story #2355, PR#2721)를 그대로 통과시킨다. 사람이 만든(또는 승격한) 연결을 지운다
 * — `reject`(기계 후보 영구 기각, rejected_relations에 기록)와는 다른 행위다.
 * status='declared'가 아닌 행은 BE가 400을 낸다.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; candidateId: string }> },
): Promise<Response> {
  const { id, candidateId } = await params;
  return proxyToFastapiWithParams(
    request,
    '/api/v2/stories/[id]/reference-candidates/[candidateId]',
    { id, candidateId },
  );
}
