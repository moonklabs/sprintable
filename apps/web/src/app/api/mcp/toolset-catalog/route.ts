import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// E-MCP-RIGHT S1 (2da32fbf): toolset 권한 picker용 그룹 카탈로그 (SSOT).
// BE `GET /api/v2/mcp/toolset-catalog` (디디 BE / S2 연장) 프록시. 미준비 시 BE 404 →
// FE 훅(fetchToolsetCatalog)이 임시 상수로 폴백한다.
export async function GET(request: Request) {
  const _r = await proxyToFastapi(request, '/api/v2/mcp/toolset-catalog');
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
