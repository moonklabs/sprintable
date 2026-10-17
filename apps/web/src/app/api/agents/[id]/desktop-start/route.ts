import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { DESKTOP_START_KEYS } from '@/lib/desktop-start-keys';

// story #4714 — the phone app's signed start of an agent that already exists on a paired computer: POST /api/v2/agents/{id}/desktop-start
// {setup_id, project_id, idempotency_key, signed, phone_key_id} (contract 02d2cf71 §14 ②). The web never makes `signed` — the phone app's
// shell does, from the list it read itself; the server carries it unopened.
//
// Kadir (5140 lens · 3): the closed body is kept HERE as well as in the page's code — only these five keys are forwarded, whatever the caller
// sent. «No path · folder · mode · arguments · runtime goes from the web» is a structure of this route, not only a habit of one component
// (the server's schema — extra fields are a 422 — and the daemon's comparison of the signed payload remain the real guards).
const AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteParams): Promise<Response> {
  const { id } = await params;
  if (!AGENT_ID.test(id)) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ error: { code: 'bad_request' } }, { status: 422 });
  const closed: Record<string, unknown> = {};
  for (const k of DESKTOP_START_KEYS) if (k in body) closed[k] = body[k];
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  // no query goes on (the contract has none), and the caller's abort signal still reaches the upstream call (codex 3 on the delta)
  const url = new URL(request.url);
  url.search = '';
  return proxyToFastapi(new Request(url.toString(), { method: 'POST', headers, body: JSON.stringify(closed), signal: request.signal }), `/api/v2/agents/${id}/desktop-start`);
}
