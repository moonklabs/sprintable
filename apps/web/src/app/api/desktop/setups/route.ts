import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4424 (PO 15:38Z) — GET /api/v2/desktop/setups proxy: the org's connected devices for the «연결된 기기» list on /desktop.
// The backend answers only an org owner/admin (a member gets 403 — the page does not ask for a member at all).
export async function GET(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/desktop/setups');
}
