
import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// PATCH /api/agent-runs/[id]
export async function PATCH(request: Request, { params }: RouteParams) {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/agent-runs/${id}`);
}
