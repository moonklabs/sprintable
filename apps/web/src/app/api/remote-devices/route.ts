import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4533 — GET /api/v2/remote-devices proxy: my phones and the computers each is paired with (/desktop «원격 기기»). A phone
// registers itself from the phone app, never from the web (no POST here).
export async function GET(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/remote-devices');
}
