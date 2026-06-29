import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/assets/[id] → FastAPI GET /api/v2/assets/{id} ({ data: Asset })
// S6: asset embed-card 가 토큰(entity:asset:{id})을 단건 자산 메타로 해석할 때 사용.
// 비-UUID id 는 400 fail-fast(BE에 garbage 전달 방지). BE 단건 GET 미착지면 비-2xx → 클라이언트 graceful missing.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  if (!UUID_RE.test(id)) return ApiErrors.badRequest('invalid asset id');
  const _r = await proxyToFastapi(request, `/api/v2/assets/${id}`);
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}

// DELETE /api/assets/[id] → FastAPI DELETE /api/v2/assets/{id}
// S5 affordance: BE delete(S7)가 아직 미착지일 수 있어 비-2xx는 클라이언트가 graceful 처리.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/assets/${id}`);
}
