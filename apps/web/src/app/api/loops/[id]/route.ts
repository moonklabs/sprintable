import { proxyToFastapi } from '@/lib/fastapi-proxy';

// GET /api/loops/[id] → FastAPI GET /api/v2/loops/{id} (org-scope IDOR-checked, raw LoopResponse).
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/loops/${id}`);
}
