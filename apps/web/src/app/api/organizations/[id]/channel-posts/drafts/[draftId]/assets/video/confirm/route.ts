import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; draftId: string }> };

// story #3556(Phase2·FE, BE #3554/#3911 계약) — 릴스 영상 업로드 2단계(확인+MP4
// 메타 파싱+규격 검증+계보 기록, 새 ChannelPostVersion 생성). 이미지 confirm
// BFF(story #3428)와 동형 — 백엔드
// backend/app/routers/channel_posts.py::post_channel_post_video_confirm으로 그대로
// 위임.
export async function POST(request: Request, { params }: RouteParams) {
  const { id, draftId } = await params;
  const _r = await proxyToFastapiWithParams(
    request,
    '/api/v2/organizations/[id]/channel-posts/drafts/[draftId]/assets/video/confirm',
    { id, draftId },
  );
  if (!_r.ok) return _r;
  // 백엔드가 201로 새 버전 생성을 알린다(assets/confirm/route.ts와 동일 이유).
  return apiSuccess(await _r.json(), undefined, _r.status);
}
