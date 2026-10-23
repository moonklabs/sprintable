import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story 4734 — [빼기] once for the computer: DELETE /api/v2/remote-devices/{id}/computers/{computer_id} — one phone ↔ every setup of one computer (the phone's
// owner or an org owner/admin). Answers {removed, pairs}. Only the ids' shape is checked here.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteParams = { params: Promise<{ id: string; computerId: string }> };

export async function DELETE(request: Request, { params }: RouteParams): Promise<Response> {
  const { id, computerId } = await params;
  if (!UUID.test(id) || !UUID.test(computerId)) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  return proxyToFastapi(request, `/api/v2/remote-devices/${id}/computers/${computerId}`);
}
