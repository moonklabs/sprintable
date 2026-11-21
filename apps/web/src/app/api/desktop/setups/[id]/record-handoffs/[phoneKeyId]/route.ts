import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story 4978 (C1b-phone) — a phone puts its SEALED record-key handoff for a computer of the person's organization: PUT /api/v2/desktop/setups/{setup}/record-handoffs/{phone_key_id} with {"envelope": …} → {id, expires_at}. The shell seals it
// (`handoff.make`: the history the person chose on the shell's own number window · the keys · the writers); neither the server nor this route can open it. The server judges who may (the phone must be the caller's own and paired with that
// computer) and the envelope's shape (one receiver, fixed size); this route closes the body to the one agreed field and holds it to the server's own size before it is read. There is no query.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 32 * 1024; // the server's own bound for `{"envelope": …}`

type RouteParams = { params: Promise<{ id: string; phoneKeyId: string }> };

export async function PUT(request: Request, { params }: RouteParams): Promise<Response> {
  const { id, phoneKeyId } = await params;
  if (!UUID.test(id) || !UUID.test(phoneKeyId)) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  const declared = request.headers.get('content-length');
  if (declared === null || !/^\d+$/.test(declared)) return Response.json({ error: { code: 'length_required' } }, { status: 411 });
  if (Number(declared) > MAX_BODY) return Response.json({ error: { code: 'record_handoff_too_large' } }, { status: 413 });
  const text = await request.text().catch(() => null);
  if (text === null || text.length > MAX_BODY) return Response.json({ error: { code: 'bad_request' } }, { status: 422 });
  let body: Record<string, unknown> | null = null;
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = null; }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !('envelope' in body) || typeof body.envelope !== 'object' || body.envelope === null || Array.isArray(body.envelope)) {
    return Response.json({ error: { code: 'bad_request' } }, { status: 422 });
  }
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  const url = new URL(request.url);
  url.search = '';
  const res = await proxyToFastapi(new Request(url.toString(), { method: 'PUT', headers, body: JSON.stringify({ envelope: body.envelope }), signal: request.signal }), `/api/v2/desktop/setups/${id}/record-handoffs/${phoneKeyId}`);
  const out = new Headers(res.headers);
  out.set('Cache-Control', 'no-store');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}
