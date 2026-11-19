import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story 4981 (연결 ③ · PR 4) — GET /api/v2/agents/{id}/desktop-usage proxy: the agent usage numbers of the computer that agent runs on (whoever may see the agent's session — the server's own check).
// The web only looks; the numbers are what the computer's host said, never anything this page decides by.
const AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams): Promise<Response> {
  const { id } = await params;
  if (!AGENT_ID.test(id)) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  return proxyToFastapi(request, `/api/v2/agents/${id}/desktop-usage`);
}
