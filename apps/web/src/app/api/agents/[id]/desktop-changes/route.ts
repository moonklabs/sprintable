import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4951 (①c) — the web's ask for the changed-file LIST of an agent session's folder: POST /api/v2/agents/{id}/desktop-changes {session_key}.
// A person's own session; who may read (the computer's pairing person alone) and every limit are the server's (PR ①a). The body is closed HERE as well (the way the start
// proxy closes its own): only `session_key` is forwarded, whatever the caller sent — «no folder · path · signature goes from the web» is a structure of this route.
const AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteParams): Promise<Response> {
  const { id } = await params;
  if (!AGENT_ID.test(id)) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ error: { code: 'bad_request' } }, { status: 422 });
  const closed: Record<string, unknown> = {};
  if ('session_key' in body) closed.session_key = body.session_key;
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  const url = new URL(request.url);
  url.search = ''; // no query goes on, and the caller's abort signal still reaches the upstream call
  const res = await proxyToFastapi(new Request(url.toString(), { method: 'POST', headers, body: JSON.stringify(closed), signal: request.signal }), `/api/v2/agents/${id}/desktop-changes`);
  const out = new Headers(res.headers);
  out.set('Cache-Control', 'no-store'); // the answer names a command of a person's computer: never kept (codex ①c r1 #4)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}
