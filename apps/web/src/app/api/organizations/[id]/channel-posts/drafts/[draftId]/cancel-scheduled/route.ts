import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; draftId: string }> };

// story #3426(BE #3419, PR#3774) — 예약 발행 취소(휴먼 전용 안의 좁은 축, 백엔드
// backend/app/routers/channel_posts.py::_require_owner_or_admin이 owner/admin만
// 허용 — 발행 자체보다 한 단계 더 좁다, 되돌릴 수 있는 파괴적 상태전환이라서). 검증
// 로직 0 — PUBLICATION_COMMAND_NOT_FOUND(404)·PUBLICATION_COMMAND_NOT_CANCELLABLE
// (409, current_status 동봉)·권한 403 전부 서버 응답 그대로 pass-through.
export async function POST(request: Request, { params }: RouteParams) {
  const { id, draftId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/channel-posts/drafts/[draftId]/cancel-scheduled', { id, draftId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
