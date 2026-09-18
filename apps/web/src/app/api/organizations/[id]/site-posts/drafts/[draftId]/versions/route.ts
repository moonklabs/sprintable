import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; draftId: string }> };

// story #3368(Phase0·마케팅운영 S4) — 한 초안의 버전 이력(에이전트 원안 vs 휴먼 개정본,
// story #3365 AC6). backend/app/routers/site_posts.py::list_site_post_draft_version_history
// 그대로 위임.
export async function GET(request: Request, { params }: RouteParams) {
  const { id, draftId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/site-posts/drafts/[draftId]/versions', { id, draftId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
