import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4951 (①c) — the list itself: GET /api/v2/agents/{id}/desktop-changes/{command_id}. The server hands a list over ONCE (it deletes it on reading) and answers
// 404 `changes_read_not_found` for every other case — nothing is cached here (the answer carries `Cache-Control: no-store`).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** the shared proxy keeps a few headers only, so the server's `Cache-Control: no-store` is said again here — a list of a person's file names is never kept by a browser or a cache in between (codex ①c r1 #4) */
function noStore(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'no-store');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

type RouteParams = { params: Promise<{ id: string; commandId: string }> };

export async function GET(request: Request, { params }: RouteParams): Promise<Response> {
  const { id, commandId } = await params;
  if (!UUID.test(id) || !UUID.test(commandId)) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  const url = new URL(request.url);
  url.search = ''; // no query goes on (codex ①c r1 #1); the caller's abort signal still reaches the upstream call
  const res = await proxyToFastapi(new Request(url.toString(), { method: 'GET', headers: request.headers, signal: request.signal }), `/api/v2/agents/${id}/desktop-changes/${commandId}`);
  return noStore(res);
}
