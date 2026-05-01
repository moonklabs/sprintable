import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/agent-personas/${id}`);
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/agent-personas/${id}`);
}

export async function DELETE(request: Request, { params }: RouteParams) {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/agent-personas/${id}`);
}
