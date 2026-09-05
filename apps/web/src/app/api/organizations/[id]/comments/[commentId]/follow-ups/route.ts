import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; commentId: string }> };

// story #3517(Phase2·FE, BE #3867 조각②) — 댓글 「작업으로 전환」. `POST /api/v2/
// organizations/{org_id}/comments/{comment_id}/follow-ups` 위임. 사람 전용
// (COMMENT_REPLY_HUMAN_ONLY 403 — BE _require_human이 이미 강제, 이 BFF는 role을
// 더 좁히지 않는다, publications/[publicationId]/follow-ups/route.ts와 동일 관례).
export async function POST(request: Request, { params }: RouteParams) {
  const { id, commentId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/comments/[commentId]/follow-ups', { id, commentId },
  );
  if (!_r.ok) return _r;
  // 백엔드가 201로 생성을 알린다(계약표 명시) — apiSuccess 기본값(200)에 묻히면
  // 소비부가 상태 코드로 "새로 만들어짐"을 못 구분한다.
  return apiSuccess(await _r.json(), undefined, _r.status);
}
