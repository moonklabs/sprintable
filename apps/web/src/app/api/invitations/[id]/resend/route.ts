import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/** POST /api/invitations/[id]/resend */
export async function POST(request: Request, _ctx: RouteParams) {
  return proxyToFastapi(request, '/api/v2/invitations/resend');
}
