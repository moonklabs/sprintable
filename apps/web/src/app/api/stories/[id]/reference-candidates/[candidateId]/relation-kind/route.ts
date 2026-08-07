import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

/**
 * POST /api/stories/{id}/reference-candidates/{candidateId}/relation-kind — story #2358.
 * BE `POST /api/v2/stories/{id}/reference-candidates/{candidate_id}/relation-kind`(story
 * #2223 판정)를 그대로 통과시킨다. body={relation_kind: 'spawned'|'followed'|'superseded'|null} —
 * declare와 «다른 질문»이라 별도 호출(순서 강제 없음, null이면 미분류로 되돌린다).
 * ⛔IDOR 제약은 declare/route.ts와 동형(candidate.source_id와 {id} 일치 필수).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; candidateId: string }> },
): Promise<Response> {
  const { id, candidateId } = await params;
  return proxyToFastapiWithParams(
    request,
    '/api/v2/stories/[id]/reference-candidates/[candidateId]/relation-kind',
    { id, candidateId },
  );
}
