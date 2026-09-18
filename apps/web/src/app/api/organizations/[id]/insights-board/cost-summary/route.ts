import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// story #3809(Phase3·3-7 PR 3, 페드루 PO 確定 2026-09-11) — BE `GET
// /api/v2/organizations/{org_id}/insights-board/cost-summary`(PR1/PR2b) 위임. 값
// 조립·검증 로직 0(insights-board/route.ts와 동형 — 쿼리 파라미터가 없다는
// 점만 다르다).
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/organizations/[id]/insights-board/cost-summary', { id });
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
