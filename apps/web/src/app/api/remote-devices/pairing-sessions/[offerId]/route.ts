import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story 4972 — the phone app waits for the computer's nonce on the new pairing: GET /api/v2/remote-devices/pairing-sessions/{offer_id}
// ?setup_id=… → {state: committed|nonce|revealed|burned|expired, n_m, sig}. Only the phone that committed reads it (the server says «not found» to anyone else). Ids only take their shape here.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type RouteParams = { params: Promise<{ offerId: string }> };

export async function GET(request: Request, { params }: RouteParams): Promise<Response> {
  const { offerId } = await params;
  const setupId = new URL(request.url).searchParams.get('setup_id') ?? '';
  if (!UUID.test(offerId) || !UUID.test(setupId)) return Response.json({ error: { code: 'offer_not_found' } }, { status: 404 });
  return proxyToFastapi(request, `/api/v2/remote-devices/pairing-sessions/${offerId}`);
}
