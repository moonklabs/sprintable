import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4532 — the phone app offers its key to the computer whose QR it scanned: POST /api/v2/remote-devices/pairing-offers
// {setup_id, offer_id, phone_key_id, label, expires_at, mac} (contract 02d2cf71 §10 ⑤ v1.11). The MAC is made by the phone app's
// shell with the QR's secret, which never reaches the web or the server.
export async function POST(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/remote-devices/pairing-offers');
}
