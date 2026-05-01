import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/** POST /api/projects/:id/invitations */
export async function POST(request: Request, _ctx: RouteParams) {
  return proxyToFastapi(request, '/api/v2/projects/invitations');
}
