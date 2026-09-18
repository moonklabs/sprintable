import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// story 4180f67f — org에 등록된 커넥터 전체 목록(신설 백엔드 GET /organizations/{id}/connectors,
// backend/app/routers/connectors.py::list_connectors). 조직 커넥터 설정 화면이 connector_key를
// 미리 몰라도 이 목록으로 카드를 그린다(하드코딩 금지, PO 명시 기각).
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/organizations/[id]/connectors', { id });
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
