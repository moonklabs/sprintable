import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/**
 * org 기본값 게이트 config 프록시 (S-GATE-4). BE `GET/PUT /api/v2/organizations/{org_id}/gate-config`.
 * GET = org-default 단독 매트릭스(project override 무시) / PUT(#1571) = org 기본값 셀 설정
 * (`{work_type,actor_type,level}`·scope 없음). 권한 org admin/owner(BE 강제).
 */
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/organizations/[id]/gate-config', { id });
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess([]);
  return apiSuccess(await _r.json());
}

export async function PUT(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/organizations/[id]/gate-config', { id });
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
