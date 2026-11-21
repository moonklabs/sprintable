import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story 4978 (C1b-phone) — the record-key handoffs computers have put for THIS phone: GET /api/v2/desktop/record-handoffs?phone_key_id → {items:[{id, setup_id, envelope, created_at}]}. Every envelope is SEALED for the phone: neither the server nor this
// route can open one — the phone app's shell does (`handoff.take`). The server answers only for a key of the caller's own; this route says nothing of its own about who may. The query is closed HERE: the one agreed word, in its shape, once —
// anything else is a 422 that calls nothing. Nothing is cached: the answer holds sealed keys.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request): Promise<Response> {
  const q = new URL(request.url).searchParams;
  if (q.getAll('phone_key_id').length > 1 || [...q.keys()].some((k) => k !== 'phone_key_id')) return Response.json({ error: { code: 'bad_request' } }, { status: 422 });
  const phone = q.get('phone_key_id');
  if (!phone || !UUID.test(phone)) return Response.json({ error: { code: 'bad_request' } }, { status: 422 });
  const url = new URL(request.url);
  url.search = '';
  url.searchParams.set('phone_key_id', phone);
  const res = await proxyToFastapi(new Request(url.toString(), { method: 'GET', headers: request.headers, signal: request.signal }), '/api/v2/desktop/record-handoffs');
  const out = new Headers(res.headers);
  out.set('Cache-Control', 'no-store');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}
