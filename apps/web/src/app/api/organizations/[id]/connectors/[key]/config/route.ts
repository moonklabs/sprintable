import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; key: string }> };

// story 4180f67f — org_config 값 저장(백엔드 PUT /organizations/{id}/connectors/{key}/config,
// org owner/admin 전용·선언된 키만·시크릿 이름 거부는 서버가 강제). connectors.py::
// put_connector_config와 동형 — 이 라우트는 그대로 위임할 뿐 검증 로직 0.
export async function PUT(request: Request, { params }: RouteParams) {
  const { id, key } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/connectors/[key]/config', { id, key },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
