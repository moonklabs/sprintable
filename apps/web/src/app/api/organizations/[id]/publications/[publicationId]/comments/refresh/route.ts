import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; publicationId: string }> };

// story #3517(Phase2·FE, BE #3865 조각①, PO 確定 2026-09-05) — 수동 재수집.
// 429 COMMENT_REFRESH_RATE_LIMITED(Retry-After 헤더+메시지)·422
// COMMENT_COLLECTION_UNSUPPORTED·403 COMMENT_REFRESH_HUMAN_ONLY(에이전트)·502(채널
// fetch 실패)까지 전부 그대로 위임 — 이 BFF는 검증·재해석 0(follow-ups/route.ts와
// 동일 관례, 사람 전용도 BE _require_human이 이미 강제).
export async function POST(request: Request, { params }: RouteParams) {
  const { id, publicationId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/publications/[publicationId]/comments/refresh', { id, publicationId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
