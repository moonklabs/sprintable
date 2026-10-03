import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4533 — GET /api/v2/remote-devices proxy: my phones and the computers each is paired with (/desktop «원격 기기»).
export async function GET(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/remote-devices');
}

// story #4532 — a phone registers its key (§10 ①: {label, public_key}) — only from inside the phone app (the key comes from its
// shell; a browser has none, so its pages never call this).
export async function POST(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/remote-devices');
}
