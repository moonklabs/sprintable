import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; draftId: string }> };

// story #3428(Phase1·마케팅운영, BE 620beefc/PR#3776) — T3-M 이미지 첨부 업로드 2단계
// (확인+자동 변환+계보 기록, 새 ChannelPostVersion 생성). 백엔드
// backend/app/routers/channel_posts.py::post_channel_post_image_confirm으로 그대로
// 위임(submit/route.ts와 동형 — 검증 로직 0).
export async function POST(request: Request, { params }: RouteParams) {
  const { id, draftId } = await params;
  const _r = await proxyToFastapiWithParams(
    request,
    '/api/v2/organizations/[id]/channel-posts/drafts/[draftId]/assets/confirm',
    { id, draftId },
  );
  if (!_r.ok) return _r;
  // 백엔드가 201로 새 버전 생성을 알린다(drafts/route.ts POST와 동일 이유).
  return apiSuccess(await _r.json(), undefined, _r.status);
}
