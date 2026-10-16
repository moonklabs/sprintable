import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4714 — the phone app's signed start of an agent that already exists on a paired computer: POST /api/v2/agents/{id}/desktop-start
// {setup_id, project_id, idempotency_key, signed, phone_key_id} (contract 02d2cf71 §14 ②). The web never makes `signed` — the phone app's
// shell does, from the list it read itself; the server carries it unopened. No path · mode · arguments reach the server from here.
const AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteParams): Promise<Response> {
  const { id } = await params;
  if (!AGENT_ID.test(id)) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  return proxyToFastapi(request, `/api/v2/agents/${id}/desktop-start`);
}
