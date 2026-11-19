import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story 4983 (P5) — the computer's SEALED answer: GET /api/v2/desktop/computers/{id}/files/{command_id}. The server hands it over ONCE (it deletes it on reading) and answers 404 `files_read_not_found` for every other
// case — nothing is cached here (the answer carries `Cache-Control: no-store`). The envelope is opened by the phone's shell only.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** the shared proxy keeps a few headers only, so the server's `Cache-Control: no-store` is said again here — a sealed answer of a person's folders is never kept by a browser or a cache in between */
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
  url.search = ''; // no query goes on; the caller's abort signal still reaches the upstream call
  const res = await proxyToFastapi(new Request(url.toString(), { method: 'GET', headers: request.headers, signal: request.signal }), `/api/v2/desktop/computers/${id}/files/${commandId}`);
  return noStore(res);
}
