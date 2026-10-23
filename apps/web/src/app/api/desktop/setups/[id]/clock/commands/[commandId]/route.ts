import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4733 (S4b) — how a session-management press from this person's phone went: GET /api/v2/desktop/setups/{id}/clock/commands/{command_id}
// → {command_id, kind, action, state, result_code}. Only the presser's own commands (the server answers 404 for anyone else's).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteParams = { params: Promise<{ id: string; commandId: string }> };

export async function GET(request: Request, { params }: RouteParams): Promise<Response> {
  const { id, commandId } = await params;
  if (!UUID.test(id) || !UUID.test(commandId)) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  const url = new URL(request.url);
  url.search = '';
  return proxyToFastapi(new Request(url.toString(), { method: 'GET', headers: new Headers(request.headers), signal: request.signal }), `/api/v2/desktop/setups/${id}/clock/commands/${commandId}`);
}
