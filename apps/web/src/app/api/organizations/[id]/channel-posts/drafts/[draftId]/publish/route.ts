import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; draftId: string }> };

// story #3402(Phase1·마케팅운영) — 발행(T7, 휴먼 전용 — 백엔드
// backend/app/routers/channel_posts.py::publish_channel_post_draft_endpoint의
// CHANNEL_POST_PUBLISH_HUMAN_ONLY 403 가드가 이미 인가를 처리한다, story #f8f7cb0f·#3395·
// #3346 참고). 검증 로직 0 — 부분 성공(container_created)·경합(CHANNEL_PUBLISH_IN_PROGRESS
// 409, story #3395) 판정도 전부 서버 응답 그대로 pass-through.
export async function POST(request: Request, { params }: RouteParams) {
  const { id, draftId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/channel-posts/drafts/[draftId]/publish', { id, draftId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
