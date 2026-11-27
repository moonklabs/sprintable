import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { LONG_ROUTES } from '@/lib/bff-route-timeouts';

// story 5041 — the press: the server runs the stored call under THIS person's own session (never an API key), so the wait is the wait of that call
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/agent-actions/${id}/decision`, { timeoutMs: LONG_ROUTES.agentActionDecision.bffMs });
}
