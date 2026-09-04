import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; draftId: string }> };

// story #3445 — 상세 page.tsx(`…/drafts/${draftId}`)가 부르는 단건 GET BFF가 애초에
// 없어(형제 폴더 cancel-scheduled·publish·submit·unpublish·versions 5개는 있음) 상세
// 첫 로드가 항상 404였다. drafts/route.ts(목록)와 동형 패턴 — 검증 로직 0, 그대로 위임.
export async function GET(request: Request, { params }: RouteParams) {
  const { id, draftId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/channel-posts/drafts/[draftId]', { id, draftId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
