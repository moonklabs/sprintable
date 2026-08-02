import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

/**
 * GET /api/stories/{id}/rejected-relations — story #2357. BE
 * `GET /api/v2/stories/{id}/rejected-relations`를 그대로 통과시킨다. 이 story가 기각한
 * 관계 목록(되살리기 재료) — 지금까지 FE 소비처가 0건이었다(유나 적발, 2026-07-31).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return proxyToFastapiWithParams(request, '/api/v2/stories/[id]/rejected-relations', { id });
}
