import { handleApiError } from '@/lib/api-error';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4397 — the app switches its own device off by token when it lands on /login (logout · expired session) or starts
// without a session. Public in proxy.ts (no session exists then); the backend only switches off and always answers 204,
// which is passed through as is (422 · 429 too).
export async function POST(request: Request) {
  try {
    // public: there is no session here (that is the point) — without it the proxy answers 401 before reaching FastAPI.
    const _r = await proxyToFastapi(request, '/api/v2/push/devices/unregister', { public: true });
    if (!_r.ok) return _r;
    return new Response(null, { status: 204 });
  } catch (error) { return handleApiError(error); }
}
