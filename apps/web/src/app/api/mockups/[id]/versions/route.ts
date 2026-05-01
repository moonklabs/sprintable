import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/** GET — 버전 히스토리 */
export async function GET(request: Request, _ctx: RouteParams) {
  return proxyToFastapi(request, '/api/v2/mockups/versions');
}

/** POST — 버전 복원 */
export async function POST(request: Request, _ctx: RouteParams) {
  return proxyToFastapi(request, '/api/v2/mockups/versions');
}
