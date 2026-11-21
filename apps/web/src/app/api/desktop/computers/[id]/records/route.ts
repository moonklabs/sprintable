import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story 4977 (B3-2b) — the person's HISTORY of one chat room, as the server keeps it: GET /api/v2/desktop/computers/{id}/records?phone_key_id&conversation_id&after&limit.
// What comes back is a page of SEALED records (an envelope each) that neither the server nor this route can open — only the phone app's shell does (`records.open`). The server lets only a phone of the
// person's that is paired with that computer THIS moment read (409 `phone_not_paired` otherwise); this route says nothing of its own about who may. The query is closed HERE: only the four agreed
// words go on, each in its shape, whatever the caller sent (an unknown word or a malformed one is a 422 that calls nothing). Nothing is cached: the answer is a person's history.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COUNT = /^\d{1,15}$/;

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams): Promise<Response> {
  const { id } = await params;
  if (!UUID.test(id)) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  const q = new URL(request.url).searchParams;
  // a word given twice is an ambiguous ask (`get` would quietly take the first): refused, whatever the words are
  if (['phone_key_id', 'conversation_id', 'after', 'limit'].some((k) => q.getAll(k).length > 1)) return Response.json({ error: { code: 'bad_request' } }, { status: 422 });
  const phone = q.get('phone_key_id');
  const room = q.get('conversation_id');
  const after = q.get('after');
  const limit = q.get('limit');
  if (!phone || !UUID.test(phone) || !room || !UUID.test(room) || (after !== null && !COUNT.test(after)) || (limit !== null && (!COUNT.test(limit) || Number(limit) < 1 || Number(limit) > 100))) {
    return Response.json({ error: { code: 'bad_request' } }, { status: 422 });
  }
  const url = new URL(request.url);
  url.search = '';
  url.searchParams.set('phone_key_id', phone);
  url.searchParams.set('conversation_id', room);
  if (after !== null) url.searchParams.set('after', after);
  if (limit !== null) url.searchParams.set('limit', limit);
  const res = await proxyToFastapi(new Request(url.toString(), { method: 'GET', headers: request.headers, signal: request.signal }), `/api/v2/desktop/computers/${id}/records`);
  const out = new Headers(res.headers);
  out.set('Cache-Control', 'no-store'); // the shared proxy keeps a few headers only: the server's `no-store` is said again here
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}
