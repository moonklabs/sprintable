import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story 4983 (P5) — a person's SEALED request to list a folder of a project on their own computer: POST /api/v2/desktop/computers/{id}/files.
// The phone's shell seals the request (the server and this route cannot open it); who may ask (the computer's pairing person, who can open the project, with a phone of theirs paired with it) and every limit are the
// server's. The body is closed HERE as well: only the four agreed fields are forwarded, whatever the caller sent — «no path, no name, no readable word goes from the web» is a structure of this route.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 16 * 1024;
const FIELDS = ['project_id', 'idempotency_key', 'phone_key_id', 'envelope'] as const;

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteParams): Promise<Response> {
  const { id } = await params;
  if (!UUID.test(id)) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  // a request is a few KiB: more than the server takes is refused here, before it is parsed (the server says the same)
  // a request is a few KiB, and it states its length: no length, or one over the limit, is refused BEFORE the body is read (the HTTP layer holds a body to the length it declared; the server judges the size again)
  const declared = request.headers.get('content-length');
  if (declared === null || !/^\d+$/.test(declared)) return Response.json({ error: { code: 'length_required' } }, { status: 411 });
  if (Number(declared) > MAX_BODY) return Response.json({ error: { code: 'files_request_too_large' } }, { status: 413 });
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
  const res = await proxyToFastapi(new Request(url.toString(), { method: 'POST', headers, body: JSON.stringify(closed), signal: request.signal }), `/api/v2/desktop/computers/${id}/files`);
  const out = new Headers(res.headers);
  out.set('Cache-Control', 'no-store'); // the answer names a request on a person's computer: never kept
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}
