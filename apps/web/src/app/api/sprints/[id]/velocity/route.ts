
import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// GET /api/sprints/:id/velocity — sprint velocity + title + status
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/sprints/${id}/velocity`);
}
