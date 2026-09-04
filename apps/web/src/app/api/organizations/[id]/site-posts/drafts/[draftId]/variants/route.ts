import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

// story 15e481ce(#3453 AC2) — Next.js는 같은 디렉터리 레벨에 서로 다른 동적 세그먼트
// 이름을 허용하지 않는다("You cannot use different slug names for the same dynamic
// path") — site-posts/drafts/ 밑에 이미 [draftId] 형제(publish·unpublish·submit·
// versions·publication)가 있어 이 라우트도 폴더명은 [draftId]를 그대로 쓴다. 값은
// content_item_id(=site-post draft id)와 같다 — 별도 리소스가 아니다.
type RouteParams = { params: Promise<{ id: string; draftId: string }> };

// story 15e481ce(#3453 AC2, 3437 API 위) — 원문(site-post draft) 쪽에서 그 원문에서
// 파생된 채널 변형 목록을 읽는다. 형제 route(channel-connections/available-channels
// 등)와 동형 패턴 — 검증 로직 0, 백엔드
// backend/app/routers/channel_posts.py::list_content_item_variants_endpoint의
// 403(org mismatch)·404(원문 없음) 그대로 pass-through.
export async function GET(request: Request, { params }: RouteParams) {
  const { id, draftId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/site-posts/drafts/[contentItemId]/variants', { id, contentItemId: draftId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
