import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; draftId: string }> };

// story #3556(Phase2·FE, BE #3554/#3911 계약) — 릴스 영상 업로드 1단계(signed URL
// 발급). 이미지 upload-url BFF(story #3428)와 동형 — 검증 로직 0, 백엔드
// backend/app/routers/channel_posts.py::post_channel_post_video_upload_url로 그대로
// 위임. 실제 PUT은 이 BFF를 거치지 않는다(브라우저가 응답의 upload_url로 GCS에 직접
// PUT — storage/base.py D3 원칙).
export async function POST(request: Request, { params }: RouteParams) {
  const { id, draftId } = await params;
  const _r = await proxyToFastapiWithParams(
    request,
    '/api/v2/organizations/[id]/channel-posts/drafts/[draftId]/assets/video/upload-url',
    { id, draftId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
