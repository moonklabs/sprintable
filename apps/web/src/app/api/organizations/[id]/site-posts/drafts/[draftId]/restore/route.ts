import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; draftId: string }> };

// story #3734 — 초안 「보관 해제」. archive/route.ts와 동형 — BE
// backend/app/routers/site_posts.py::restore_site_post_draft_endpoint 그대로 위임.
export async function POST(request: Request, { params }: RouteParams) {
  const { id, draftId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/site-posts/drafts/[draftId]/restore', { id, draftId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
