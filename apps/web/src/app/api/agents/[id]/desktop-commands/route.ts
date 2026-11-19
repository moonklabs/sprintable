import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4534 — the phone app's signed stop or instruction for an agent's running session: POST /api/v2/agents/{id}/desktop-commands
// {kind, idempotency_key, session_key, signed, phone_key_id, text?, conversation_id?} (contract 02d2cf71 §11 ②). The web never makes
// `signed` — the phone app's shell does, from the session it read itself (contract 48616ee0 v0.3); the server carries it unopened.
// story 4976 A3: an instruction a sealing shell made has no `text` and no `signed` — its body is {kind, idempotency_key, session_key, conversation_id, envelope, phone_key_id}; the envelope is the shell's sealed words (the
// server cannot open it) and its header names this press's idempotency_key. The route changes nothing: the body goes through as it came.
const AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteParams): Promise<Response> {
  const { id } = await params;
  if (!AGENT_ID.test(id)) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  return proxyToFastapi(request, `/api/v2/agents/${id}/desktop-commands`);
}
