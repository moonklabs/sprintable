import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4624 — [이 폰 빼기]: DELETE /api/v2/remote-devices/{id} — the phone key itself, with every pair of it. Its place under the
// person's limit (three phones) is free again. The phone's owner or an org owner/admin. Ids only take their shape here.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteParams = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, { params }: RouteParams): Promise<Response> {
  const { id } = await params;
  if (!UUID.test(id)) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  return proxyToFastapi(request, `/api/v2/remote-devices/${id}`);
}
