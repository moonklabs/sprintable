import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/** GET — OSS 모드에서는 null 반환 */
export async function GET(request: Request, _ctx: RouteParams) {
  return proxyToFastapi(request, '/api/v2/projects/ai-settings');
}

/** PUT */
export async function PUT(request: Request, _ctx: RouteParams) {
  return proxyToFastapi(request, '/api/v2/projects/ai-settings');
}

/** DELETE */
export async function DELETE(request: Request, _ctx: RouteParams) {
  return proxyToFastapi(request, '/api/v2/projects/ai-settings');
}
