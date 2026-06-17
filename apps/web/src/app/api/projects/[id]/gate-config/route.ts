import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/**
 * HITL 게이트 레벨 config 프록시 (S-GATE-4). BE `GET/PUT /api/v2/projects/{id}/gate-config`.
 * GET = effective 레벨 목록(`{work_type,actor_type,level}[]`) / PUT = 셀 1개 설정
 * (`{scope:'org'|'project',work_type,actor_type,level}`). 권한·안전하한은 BE 강제.
 */
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/projects/[id]/gate-config', { id });
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess([]);
  return apiSuccess(await _r.json());
}

export async function PUT(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/projects/[id]/gate-config', { id });
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
