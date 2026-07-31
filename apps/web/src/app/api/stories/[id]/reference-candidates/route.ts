import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

/**
 * POST /api/stories/{id}/reference-candidates — story #2353 후속(2026-07-31). BE
 * `POST /api/v2/stories/{id}/reference-candidates`(story #2355, PR#2721)를 그대로
 * 통과시킨다 — `goals/[id]/reference-candidates/route.ts`와 동일 패턴(원시 JSON,
 * 래핑 없음). 사람이 «후보가 아예 없던» 연결을 처음 만드는 유일한 write 경로 —
 * declare/relation-kind/reject(기존 candidate_id 필요)와 다르다.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapiWithParams(request, '/api/v2/stories/[id]/reference-candidates', { id });
}
