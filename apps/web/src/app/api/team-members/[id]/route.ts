import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, { params }: RouteParams) {
  const { id } = await params;
  return proxyToFastapiWithParams(request, '/api/v2/team-members/[id]', { id });
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const { id } = await params;
  return proxyToFastapiWithParams(request, '/api/v2/team-members/[id]', { id });
}
