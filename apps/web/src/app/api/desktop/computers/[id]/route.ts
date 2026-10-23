import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story 4734 — «이 컴퓨터 모두 끊기»: DELETE /api/v2/desktop/computers/{id} disconnects every connected setup of the computer in one transaction (all or none;
// org owner/admin; another org's id is «not found»; 409 computer_changing / computer_too_large leave everything as it was). Answers {setups_disconnected, revoked_keys, ...}.
// The computer id is derived by the server (a uuid) — only its shape is checked here.
const COMPUTER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteParams = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, { params }: RouteParams): Promise<Response> {
  const { id } = await params;
  if (!COMPUTER_ID.test(id)) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  return proxyToFastapi(request, `/api/v2/desktop/computers/${id}`);
}
