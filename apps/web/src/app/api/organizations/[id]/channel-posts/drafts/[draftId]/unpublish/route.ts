import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; draftId: string }> };

// story #3426(BE #3419, PR#3774) — 발행 글 회수(휴먼 전용 안의 좁은 축, 백엔드
// _require_owner_or_admin이 owner/admin만 허용). 검증 로직 0 — CHANNEL_POST_
// NOT_PUBLISHED(409)·CHANNEL_UNPUBLISH_UNSUPPORTED(422)·CHANNEL_SCOPE_INSUFFICIENT
// (422, required_scopes 동봉)·CHANNEL_CONNECTION_NOT_ACTIVE(409)·CHANNEL_TOKEN_
// EXPIRED(409)·CHANNEL_PUBLISH_PROVIDER_ERROR(502)·권한 403 전부 서버 응답 그대로
// pass-through.
export async function POST(request: Request, { params }: RouteParams) {
  const { id, draftId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/channel-posts/drafts/[draftId]/unpublish', { id, draftId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
