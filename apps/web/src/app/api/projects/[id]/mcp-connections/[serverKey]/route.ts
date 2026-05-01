import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; serverKey: string }> };

export async function PUT(request: Request, _ctx: RouteParams) {
  return proxyToFastapi(request, '/api/v2/projects/mcp-connections');
}

export async function DELETE(request: Request, _ctx: RouteParams) {
  return proxyToFastapi(request, '/api/v2/projects/mcp-connections');
}
