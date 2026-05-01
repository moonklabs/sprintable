import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/** GET — 시나리오 목록 */
export async function GET(request: Request, _ctx: RouteParams) {
  return proxyToFastapi(request, '/api/v2/mockups/scenarios');
}

/** POST — 시나리오 생성 */
export async function POST(request: Request, _ctx: RouteParams) {
  return proxyToFastapi(request, '/api/v2/mockups/scenarios');
}

/** PATCH — 시나리오 수정 */
export async function PATCH(request: Request, _ctx: RouteParams) {
  return proxyToFastapi(request, '/api/v2/mockups/scenarios');
}

/** DELETE — 시나리오 삭제 (default 불가) */
export async function DELETE(request: Request, _ctx: RouteParams) {
  return proxyToFastapi(request, '/api/v2/mockups/scenarios');
}
