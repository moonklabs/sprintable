import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story 4993 (4c-2) — a phone's SEALED ask for a same-network direct door on its own computer: POST /api/v2/desktop/computers/{id}/direct.
// The phone's shell seals the ask (neither the server nor this route can open it) and the page only carries it; who may ask (the computer's pairing person, with a phone of theirs paired with it) and every
// limit is the server's. The body is closed HERE as well: only the three agreed fields are forwarded, whatever the caller sent — nothing readable goes from the web, and nothing the page makes up reaches the Mac as an ask.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** an ask is a few hundred bytes: the server takes 8 KiB at most (`ASK_BODY_MAX`) — more is refused here, before it is parsed */
const MAX_BODY = 8 * 1024;
const FIELDS = ['idempotency_key', 'phone_key_id', 'envelope'] as const;

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteParams): Promise<Response> {
  const { id } = await params;
  if (!UUID.test(id)) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  // the body states its length: no length, or one over the limit, is refused BEFORE the body is read
  const declared = request.headers.get('content-length');
  if (declared === null || !/^\d+$/.test(declared)) return Response.json({ error: { code: 'length_required' } }, { status: 411 });
  if (Number(declared) > MAX_BODY) return Response.json({ error: { code: 'direct_request_too_large' } }, { status: 413 });
  const text = await request.text().catch(() => null);
  if (text === null) return Response.json({ error: { code: 'bad_request' } }, { status: 422 });
  let body: Record<string, unknown> | null = null;
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ error: { code: 'bad_request' } }, { status: 422 });
  const closed: Record<string, unknown> = {};
  for (const k of FIELDS) if (k in body) closed[k] = body[k];
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  const url = new URL(request.url);
  url.search = ''; // no query goes on, and the caller's abort signal still reaches the upstream call
  const res = await proxyToFastapi(new Request(url.toString(), { method: 'POST', headers, body: JSON.stringify(closed), signal: request.signal }), `/api/v2/desktop/computers/${id}/direct`);
  const out = new Headers(res.headers);
  out.set('Cache-Control', 'no-store'); // the answer names an ask on a person's computer: never kept
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}
