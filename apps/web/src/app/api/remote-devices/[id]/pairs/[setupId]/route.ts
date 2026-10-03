import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4533 — [빼기]: DELETE /api/v2/remote-devices/{id}/pairs/{setup_id} — one phone ↔ computer pair, at once on the server and
// sent down to the computer until it drops the key. The phone's owner or an org owner/admin. Ids only take their shape here.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteParams = { params: Promise<{ id: string; setupId: string }> };

export async function DELETE(request: Request, { params }: RouteParams): Promise<Response> {
  const { id, setupId } = await params;
  if (!UUID.test(id) || !UUID.test(setupId)) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  return proxyToFastapi(request, `/api/v2/remote-devices/${id}/pairs/${setupId}`);
}
