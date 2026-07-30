import { proxyToFastapi } from '@/lib/fastapi-proxy';

/**
 * GET /api/reference-candidates/next-up — story #2224 후속(2026-07-31, "다음을 만드는 화면").
 * BE `GET /api/v2/reference-candidates/next-up`(PR#2707, 디디군)을 그대로 통과시킨다 —
 * `goals/[id]/reference-candidates/route.ts`와 동일 패턴(원시 `list[dict]`, 래핑 없음,
 * 페이지네이션 없음 — BE가 전량 반환). `project_id`/`recent_days` 쿼리는 `proxyToFastapi`가
 * `url.search`를 그대로 전달하므로 이 라우트에서 따로 안 받는다.
 */
export async function GET(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/reference-candidates/next-up');
}
