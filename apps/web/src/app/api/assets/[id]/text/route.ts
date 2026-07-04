import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/assets/[id]/text → FastAPI GET /api/v2/assets/{id}/text ({ data: AssetTextResponse })
// E-LOOP-LEDGER S24b — text_truncated(>4KB) 아티팩트의 "더보기" lazy refetch. 400(not-text)/
// 404/503(storage 일시장애, BE가 명시 graceful) 전부 비-2xx passthrough → 클라이언트가 처리.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  if (!UUID_RE.test(id)) return ApiErrors.badRequest('invalid asset id');
  const _r = await proxyToFastapi(request, `/api/v2/assets/${id}/text`);
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
