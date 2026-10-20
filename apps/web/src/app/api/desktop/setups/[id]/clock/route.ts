import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { DESKTOP_CLOCK_KEYS } from '@/lib/desktop-clock-keys';

// story #4733 (S4b · contract: dan/4733-phone-clock-design-1020.md §7) — a phone's session management of one computer.
//   POST /api/v2/desktop/setups/{id}/clock {action, idempotency_key, signed, phone_key_id, agent_member_id?} → 201 {command_id, state}
//   GET  /api/v2/desktop/setups/{id}/clock?phone_key_id=… → {remote_control, reachable, supported, view}  (the computer's closed view; null when no flow is open)
// The web never makes `signed` — the phone app's shell does, from the list it read itself; the server carries it unopened.
//
// The closed body is kept HERE as well as in the page's code (the same rule as desktop-start, Kadir 5140 lens · 3): only these keys are forwarded, whatever the
// caller sent; no query goes on a POST, and a GET carries one bare key id. The server's schema (extra fields are a 422) and the daemon's comparison of the signed
// payload remain the real guards.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteParams): Promise<Response> {
  const { id } = await params;
  if (!UUID.test(id)) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ error: { code: 'bad_request' } }, { status: 422 });
  const closed: Record<string, unknown> = {};
  for (const k of DESKTOP_CLOCK_KEYS) if (k in body) closed[k] = body[k];
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  const url = new URL(request.url);
  url.search = '';
  return proxyToFastapi(new Request(url.toString(), { method: 'POST', headers, body: JSON.stringify(closed), signal: request.signal }), `/api/v2/desktop/setups/${id}/clock`);
}

export async function GET(request: Request, { params }: RouteParams): Promise<Response> {
  const { id } = await params;
  if (!UUID.test(id)) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  const key = new URL(request.url).searchParams.get('phone_key_id');
  if (key === null || !UUID.test(key)) return Response.json({ error: { code: 'bad_request' } }, { status: 422 });
  const url = new URL(request.url);
  url.search = '';
  url.searchParams.set('phone_key_id', key);
  return proxyToFastapi(new Request(url.toString(), { method: 'GET', headers: new Headers(request.headers), signal: request.signal }), `/api/v2/desktop/setups/${id}/clock`);
}
