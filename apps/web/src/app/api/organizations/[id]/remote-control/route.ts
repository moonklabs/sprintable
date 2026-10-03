import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/**
 * story #4535 — 조직 «원격 제어» 스위치 프록시. BE `GET/PUT /api/v2/organizations/{org_id}/remote-control`.
 * GET = 그 조직 사람 열람({enabled, enabled_at, can_change}) / PUT = owner만(admin · 에이전트 키 403, BE 강제).
 */
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/organizations/[id]/remote-control', { id });
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}

export async function PUT(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/organizations/[id]/remote-control', { id });
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
