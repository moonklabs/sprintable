import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; draftId: string; imageId: string }> };

// story #3550(Phase2 BE 2/2, 페드루 PO 確定 2026-09-06) — 이미지 1장 삭제. 새 불변
// 버전을 만들어 반영(#3291 규율) — 응답은 새 버전에 남은 이미지 전체(assets/confirm/
// route.ts와 동형 위임, 검증 로직 0).
export async function DELETE(request: Request, { params }: RouteParams) {
  const { id, draftId, imageId } = await params;
  const _r = await proxyToFastapiWithParams(
    request,
    '/api/v2/organizations/[id]/channel-posts/drafts/[draftId]/assets/[imageId]',
    { id, draftId, imageId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
