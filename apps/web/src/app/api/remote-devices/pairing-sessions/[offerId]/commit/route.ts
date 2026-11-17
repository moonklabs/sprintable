import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story 4972 — the new pairing (design ② §5-2): the phone's commitment for the offer the computer registered: POST /api/v2/remote-devices/pairing-sessions/{offer_id}/commit {setup_id, phone_key_id, commit}. The bytes are made by the phone app's shell with the QR's secret, which never reaches the web or the server. Ids only take their shape here.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type RouteParams = { params: Promise<{ offerId: string }> };

export async function POST(request: Request, { params }: RouteParams): Promise<Response> {
  const { offerId } = await params;
  if (!UUID.test(offerId)) return Response.json({ error: { code: 'offer_not_found' } }, { status: 404 });
  return proxyToFastapi(request, `/api/v2/remote-devices/pairing-sessions/${offerId}/commit`);
}
