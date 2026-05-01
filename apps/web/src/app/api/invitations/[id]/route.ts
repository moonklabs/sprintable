import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/** DELETE /api/invitations/[id] */
export async function DELETE(request: Request, _ctx: RouteParams) {
  return proxyToFastapi(request, '/api/v2/invitations');
}
