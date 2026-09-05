import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/**
 * story #3484(BE 3475, 페드루 PO 確定 2026-09-05) — 발행 계측 5지표(정시율·중복
 * 발행·승인 없는 adapter 호출·복구시간 p50/p95)+연결 만료 2종. BE `GET
 * /api/v2/organizations/{org_id}/publishing-metrics?window=7d|30d` → `{window,
 * on_time_rate, on_time_numer, on_time_denom, duplicate_publications,
 * unapproved_adapter_calls, recovery_seconds_p50, recovery_seconds_p95,
 * connections_expired, connections_expiring_7d, computed_at}`. window 쿼리를
 * 그대로 전달(proxyToFastapi가 request.url의 search를 그대로 붙인다 — fastapi-
 * proxy.ts:59 실측, 이 라우트는 쿼리를 따로 안 옮겨도 된다).
 */
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/organizations/[id]/publishing-metrics', { id });
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
