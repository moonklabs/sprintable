import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4534 — how a stop or an instruction sent from this person's phone went: GET /api/v2/agents/{id}/desktop-commands/{command_id}
// → {command_id, kind, state, result_code} (contract 02d2cf71 §11 ②). Only the sender's own commands.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteParams = { params: Promise<{ id: string; commandId: string }> };

export async function GET(request: Request, { params }: RouteParams): Promise<Response> {
  const { id, commandId } = await params;
  if (!UUID.test(id) || !UUID.test(commandId)) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  return proxyToFastapi(request, `/api/v2/agents/${id}/desktop-commands/${commandId}`);
}
