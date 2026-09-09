import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; draftId: string }> };

// story #3734 — 초안 「보관」. 백엔드
// backend/app/routers/site_posts.py::archive_site_post_draft_endpoint 그대로 위임(인가·
// is_deleted 판정 전부 BE 책임, 이 라우트는 순수 프록시) — channel-posts/archive/route.ts
// 와 동형 패턴.
export async function POST(request: Request, { params }: RouteParams) {
  const { id, draftId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/site-posts/drafts/[draftId]/archive', { id, draftId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
