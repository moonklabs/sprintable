import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; draftId: string }> };

// story #3514(BE 신설, PO 確定 2026-09-05) — site_post는 원래 단건 GET 자체가 없었다
// (형제 폴더 campaign·publication·publish·submit·unpublish·variants·versions 7개는
// 있었지만 이 자리만 비어 있었다 — channel-posts/drafts/[draftId]/route.ts(#3445)의
// "상세 page.tsx가 부르는 단건 GET이 애초에 없었다"와 같은 클래스 갭). BE가 목록
// 항목(SitePostDraftListItem) shape에 `violations[]`(lint-on-read)를 얹은 단건
// `GET .../site-posts/drafts/{draft_id}`를 새로 낸다 — 이 라우트는 그대로 위임.
export async function GET(request: Request, { params }: RouteParams) {
  const { id, draftId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/site-posts/drafts/[draftId]', { id, draftId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
