import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; draftId: string }> };

// story #3386(Phase0 결함, S8 — 발행됨·URL·행위자) — 원인 진단이 지목한 계약 갭을 채우는
// backend/app/routers/site_posts.py::get_site_post_publication_endpoint 그대로 위임.
// GET /api/v2/organizations/{org}/site-posts/drafts/{draft_id}/publication — 발행된
// 적 없어도(또는 unpublish됐어도) 200 + 전부 null(draft 자체가 없을 때만 404, "모른다"와
// "발행 안 됐다"를 구별하는 서버측 신호).
export async function GET(request: Request, { params }: RouteParams) {
  const { id, draftId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/site-posts/drafts/[draftId]/publication', { id, draftId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
