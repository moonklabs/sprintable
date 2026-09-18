import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; commandId: string }> };

// story f061c1a3(#3422 AC3 잔여) — 실패 배지 「재시도」 클릭 배선. 백엔드
// backend/app/routers/channel_posts.py::retry_publication_command_endpoint는
// 휴먼 전용(_require_human — dead_letter·blocked 상태인 command만 pending으로
// 되돌림, 그 외는 404로 존재 비노출). 검증 로직 0 — 403(HUMAN_ONLY)·404(재시도
// 대상 아님) 전부 서버 응답 그대로 pass-through. 형제 route(cancel-scheduled·
// unpublish)와 동형 패턴.
export async function POST(request: Request, { params }: RouteParams) {
  const { id, commandId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/channel-posts/publication-commands/[commandId]/retry', { id, commandId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
