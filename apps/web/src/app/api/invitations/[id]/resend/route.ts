import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/** POST /api/invitations/[id]/resend */
export async function POST(request: Request, { params }: RouteParams) {
  const { id } = await params;
  return proxyToFastapiWithParams(request, '/api/v2/invitations/[id]/resend', { id });
}
