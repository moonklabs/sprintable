import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; commentId: string; replyId: string }> };

// story #3517(Phase2·FE, BE #3867 조각②) — 답변 상신. `POST /api/v2/organizations/
// {org_id}/comments/{comment_id}/replies/{reply_id}/submit` 위임. 사람 전용
// (COMMENT_REPLY_HUMAN_ONLY 403·COMMENT_REPLY_WRONG_STATUS 422·
// COMMENT_REPLY_TARGET_DELETED 409·COMMENT_REPLY_CHANNEL_UNSUPPORTED 422 전부
// 그대로 위임 — 이 BFF는 검증·재해석 0).
export async function POST(request: Request, { params }: RouteParams) {
  const { id, commentId, replyId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/comments/[commentId]/replies/[replyId]/submit', { id, commentId, replyId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
