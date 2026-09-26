import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';
import { LONG_ROUTES } from '@/lib/bff-route-timeouts';

type RouteParams = { params: Promise<{ id: string; draftId: string }> };

// story #3402(Phase1·마케팅운영) — 승인 요청(T4). 백엔드
// backend/app/routers/channel_posts.py::submit_channel_post_draft_endpoint(story #3374) 그대로
// 위임 — 상신은 휴먼 전용이 아니다(actor_type 가드 없음, story #3402 AC5). 검증 로직 0.
export async function POST(request: Request, { params }: RouteParams) {
  const { id, draftId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/channel-posts/drafts/[draftId]/submit', { id, draftId },
    {
      // story #4320(까디르 QA ①) — 레시피 자동 충족이면 그 자리에서 발행 — 시한은 표 한 곳(bff-route-timeouts · 근거 백엔드 파일:줄).
      timeoutMs: LONG_ROUTES.channelDraftSubmit.bffMs,
    },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
