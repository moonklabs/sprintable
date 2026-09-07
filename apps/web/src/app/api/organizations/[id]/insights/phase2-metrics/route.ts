import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// story #3618(Phase2·BE+FE·실측) — BE `GET /api/v2/organizations/{org_id}/insights/
// phase2-metrics` 위임. insights-board/route.ts와 동형(값 조립·검증 로직 0) — `days`
// 쿼리 파라미터는 이 라우트가 손대지 않는다(proxyToFastapiWithParams가 원 요청의
// url.search를 그대로 목적지에 붙여 전달).
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/insights/phase2-metrics', { id },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
