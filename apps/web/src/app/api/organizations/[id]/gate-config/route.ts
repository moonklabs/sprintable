import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/**
 * org 기본값 게이트 config 프록시 (S-GATE-4 2계층). BE `GET /api/v2/organizations/{org_id}/gate-config`
 * — org-default 단독 매트릭스(project override 무시). 권한 org admin/owner(BE 강제). 설정(PUT scope='org')은
 * project gate-config 라우트 경유.
 */
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/organizations/[id]/gate-config', { id });
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess([]);
  return apiSuccess(await _r.json());
}
