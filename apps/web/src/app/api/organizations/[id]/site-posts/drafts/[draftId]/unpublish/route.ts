import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; draftId: string }> };

// story #3386(Phase0 결함, S8) — 「발행 취소」 버튼이 부르는 story #3381(PR#3739)의
// 엔드포인트: backend/app/routers/site_posts.py::unpublish_site_post_endpoint 그대로 위임.
// POST /api/v2/organizations/{org}/site-posts/drafts/{draft_id}/unpublish, body 없음.
// PR#3739가 이 브랜치 착수 시점 아직 미병합이라 지금은 404가 그대로 pass-through된다
// (submit/route.ts가 S2 착지 前 겪은 것과 동일 관례 — 병합 뒤 이 파일 변경 없이 바로 동작).
export async function POST(request: Request, { params }: RouteParams) {
  const { id, draftId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/site-posts/drafts/[draftId]/unpublish', { id, draftId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
