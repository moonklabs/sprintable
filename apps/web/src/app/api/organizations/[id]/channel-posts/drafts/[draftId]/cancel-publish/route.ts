import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; draftId: string }> };

// story #4336 — 공급자에 아무것도 안 간 발행 명령의 취소(발행과 같은 권한 폭 · 휴먼). 검증 로직 0 —
// PUBLICATION_COMMAND_NOT_FOUND(404) · PUBLICATION_ALREADY_STARTED(409, current_status 동봉) · 권한 403 전부 서버 응답 그대로.
export async function POST(request: Request, { params }: RouteParams) {
  const { id, draftId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/channel-posts/drafts/[draftId]/cancel-publish', { id, draftId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
