import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; draftId: string }> };

// story #3614(Phase2·BE+FE) — 초안 「폐기」. 백엔드
// backend/app/routers/channel_posts.py::withdraw_channel_post_draft_endpoint 그대로 위임
// (인가·게이트 종결·발행됨 409 판정 전부 BE 책임, 이 라우트는 순수 프록시).
export async function POST(request: Request, { params }: RouteParams) {
  const { id, draftId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/channel-posts/drafts/[draftId]/withdraw', { id, draftId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
