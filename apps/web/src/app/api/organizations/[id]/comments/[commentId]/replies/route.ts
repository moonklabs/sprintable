import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; commentId: string }> };

// story #3517(Phase2·FE, BE #3867 조각②) — 답변 초안 생성. `POST /api/v2/
// organizations/{org_id}/comments/{comment_id}/replies` 위임. 에이전트도 가능
// (승인·발행부터 human-only, BE _require_human이 submit에서 강제) — 이 BFF는
// role을 더 좁히지 않는다.
export async function POST(request: Request, { params }: RouteParams) {
  const { id, commentId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/comments/[commentId]/replies', { id, commentId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json(), undefined, _r.status);
}
