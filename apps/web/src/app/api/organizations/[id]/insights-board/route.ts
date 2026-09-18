import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// story #3503(성과 보드 화면) — BE #3502(fd57310d4, origin/feat/3502-insights-board-api,
// 이 파일 작성 시점 develop 미착지) `GET /api/v2/organizations/{org_id}/insights-board`
// 위임. campaigns/route.ts(같은 GET+POST 패턴)와 동형 — 값 조립·검증 로직 0.
//
// window/channel/status/sort/sort_dir/cursor 등 쿼리 파라미터는 이 라우트가 손대지 않는다
// — proxyToFastapi(내부)가 원 요청의 url.search를 그대로 목적지에 붙여 전달한다(publications/
// [publicationId]/insights/route.ts처럼 쿼리 없는 라우트와 달리, 이 라우트는 필터/정렬/
// 페이지네이션 전부가 쿼리 파라미터라 그 통과 경로에 의존).
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/organizations/[id]/insights-board', { id });
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
