import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story 4978 (C1b-phone) — the phone has a handoff envelope (its shell opened and kept it): POST /api/v2/desktop/record-handoffs/{id}/received?phone_key_id → {deleted}. The page posts this ONLY for the rows the shell answered `taken`; the server
// deletes only a row addressed to this phone of the caller. The query is closed HERE (one word, once, in its shape); there is no body.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteParams): Promise<Response> {
  const { id } = await params;
  if (!UUID.test(id)) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  const q = new URL(request.url).searchParams;
  if (q.getAll('phone_key_id').length > 1 || [...q.keys()].some((k) => k !== 'phone_key_id')) return Response.json({ error: { code: 'bad_request' } }, { status: 422 });
  const phone = q.get('phone_key_id');
  if (!phone || !UUID.test(phone)) return Response.json({ error: { code: 'bad_request' } }, { status: 422 });
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  const url = new URL(request.url);
  url.search = '';
  url.searchParams.set('phone_key_id', phone);
  const res = await proxyToFastapi(new Request(url.toString(), { method: 'POST', headers, signal: request.signal }), `/api/v2/desktop/record-handoffs/${id}/received`);
  const out = new Headers(res.headers);
  out.set('Cache-Control', 'no-store');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}
