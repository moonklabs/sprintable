import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, _ctx: RouteParams) {
  return proxyToFastapi(request, '/api/v2/team-members');
}

export async function PATCH(request: Request, _ctx: RouteParams) {
  return proxyToFastapi(request, '/api/v2/team-members');
}
