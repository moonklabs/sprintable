import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story 4695 — which organization is the computer of the QR in, for a member of that organization: GET /api/v2/remote-devices/pairing-target
// ?setup_id=… → {org_id}. The phone's pairing page sits outside the dashboard shell (no X-Org-Id of its own), so it asks this first and then
// sends its key and its offer with that org. The id only takes its shape here; the answer is the server's (404 setup_not_found for anyone else).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function GET(request: Request): Promise<Response> {
  const setupId = new URL(request.url).searchParams.get('setup_id') ?? '';
  if (!UUID.test(setupId)) return Response.json({ error: { code: 'setup_not_found' } }, { status: 404 });
  return proxyToFastapi(request, '/api/v2/remote-devices/pairing-target');
}
