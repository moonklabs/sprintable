import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story 5041 — one request an agent made that a person may press (read for the viewer: a project they cannot see is the same 404 as a request that is not there)
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/agent-actions/${id}`);
}
