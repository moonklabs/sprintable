import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4534 — GET /api/v2/agents/{id}/desktop-session proxy: the agent's session state for its DM header (whoever can open
// that DM). The web only looks — the stop and the instruction are the phone's (signed), never sent from here.
const AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams): Promise<Response> {
  const { id } = await params;
  if (!AGENT_ID.test(id)) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  return proxyToFastapi(request, `/api/v2/agents/${id}/desktop-session`);
}
