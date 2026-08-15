import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

/**
 * GET /api/stories/{id}/attachment-suggestions — story #2534(E-FLOW-V4 S4). BE
 * `GET /api/v2/stories/{id}/attachment-suggestions`(story #2532, stories.py:855)를 그대로
 * 통과시킨다. 응답 = `{suggested_type, goal_candidates[], hypothesis_candidates[]}`(원시
 * 어휘, 래핑 없음) — 미매달림 버킷(unattached-bucket.tsx)의 자동제안 칩이 소비한다.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapiWithParams(request, '/api/v2/stories/[id]/attachment-suggestions', { id });
}
