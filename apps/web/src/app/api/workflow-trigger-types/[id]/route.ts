import { proxyToFastapi } from '@/lib/fastapi-proxy';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/workflow-trigger-types/${id}`);
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/workflow-trigger-types/${id}`);
}
