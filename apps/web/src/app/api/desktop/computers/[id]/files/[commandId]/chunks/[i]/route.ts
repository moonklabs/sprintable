import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story 4988 (P8) — chunk i of a DOWNLOAD, sealed: GET /api/v2/desktop/computers/{id}/files/{command_id}/chunks/{i}. The server hands each chunk over ONCE and in order (it deletes it on reading); 404 `files_read_not_found` for every reason
// (not yours · not this computer's · expired · not a download), 409 `files_chunk_out_of_order` for a place that is not the next. Nothing is cached here (the answer carries `Cache-Control: no-store`). The envelope is opened by the phone's shell only.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACE = /^(?:[0-9]|[1-4][0-9]|5[0-6])$/; // 0 … 56 as plain digits: the places of a download (57 chunks at most — the server's own bound)

/** the shared proxy keeps a few headers only, so the server's `Cache-Control: no-store` is said again here — a sealed chunk of a person's file is never kept by a browser or a cache in between */
function noStore(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'no-store');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

type RouteParams = { params: Promise<{ id: string; commandId: string; i: string }> };

export async function GET(request: Request, { params }: RouteParams): Promise<Response> {
  const { id, commandId, i } = await params;
  if (!UUID.test(id) || !UUID.test(commandId) || !PLACE.test(i)) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  const url = new URL(request.url);
  url.search = ''; // no query goes on; the caller's abort signal still reaches the upstream call
  const res = await proxyToFastapi(new Request(url.toString(), { method: 'GET', headers: request.headers, signal: request.signal }), `/api/v2/desktop/computers/${id}/files/${commandId}/chunks/${i}`);
  return noStore(res);
}
