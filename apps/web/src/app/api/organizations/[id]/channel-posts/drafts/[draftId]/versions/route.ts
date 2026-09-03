import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; draftId: string }> };

// story #3402(Phase1·마케팅운영) — 한 채널 포스트 초안의 버전 이력. 백엔드
// backend/app/routers/channel_posts.py::list_channel_post_draft_version_history(story #3374)
// 그대로 위임. tagged_link_preview(#3394 AC5)도 이 응답에 실려 있다 — BFF는 검증 로직 0.
export async function GET(request: Request, { params }: RouteParams) {
  const { id, draftId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/channel-posts/drafts/[draftId]/versions', { id, draftId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
