import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/** DELETE /api/organizations/[id] */
export async function DELETE(request: Request, { params }: RouteParams) {
  const { id } = await params;
  return proxyToFastapiWithParams(request, '/api/v2/organizations/[id]', { id });
}
