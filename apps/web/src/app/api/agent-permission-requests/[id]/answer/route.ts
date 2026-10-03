import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4532 — the phone app's signed answer to an agent's permission request: POST /api/v2/agent-permission-requests/{id}/answer
// {decision, signed, phone_key_id} (contract 02d2cf71 §9 ③). The web never makes `signed` — the phone app's shell does, from the
// server's own row (design 0dceadda v3.1 ①); the server carries it unopened to the computer. Ids only take their shape here.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteParams): Promise<Response> {
  const { id } = await params;
  if (!UUID.test(id)) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  return proxyToFastapi(request, `/api/v2/agent-permission-requests/${id}/answer`);
}
