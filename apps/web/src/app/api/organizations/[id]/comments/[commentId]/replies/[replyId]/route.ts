import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; commentId: string; replyId: string }> };

// story #3517(Phase2·FE, BE #3867 조각②) — 답변 단건 조회. `GET /api/v2/
// organizations/{org_id}/comments/{comment_id}/replies/{reply_id}` 위임. 조직
// 멤버(휴먼·에이전트 모두) 읽기 가능 — 목록 GET과 동형 권한 폭(계약표 명시).
export async function GET(request: Request, { params }: RouteParams) {
  const { id, commentId, replyId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/comments/[commentId]/replies/[replyId]', { id, commentId, replyId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
