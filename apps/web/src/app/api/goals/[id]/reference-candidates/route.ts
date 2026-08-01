import { proxyToFastapi } from '@/lib/fastapi-proxy';

/**
 * GET /api/goals/{id}/reference-candidates — story #2224 후속(2026-07-30). BE
 * `GET /api/v2/goals/{id}/reference-candidates`(PR#2704)를 그대로 통과시킨다 —
 * `dependencies/graph/route.ts`와 동일 패턴(원시 `list[dict]`, 래핑 없음). BE가 이미
 * 원시 어휘 그대로 내기로 확定했으므로(오르테가군 판정) 이 자리에서 변형하지 않는다 —
 * 종류 매핑/필터링은 FE의 `parseReferenceCandidateEdges`(derive-flow-map.ts) 몫.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/goals/${id}/reference-candidates`);
}
