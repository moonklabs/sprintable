import { handleApiError } from '@/lib/api-error';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4394 — the app reports where push registration stopped (permission · native token · Expo token · register · ok) so a
// release build that fails silently leaves a server-side trace. Thin pass-through like /api/push/devices; the backend answers
// 204 (no body), which is passed through as is. No session → the backend's 401; over the per-member cap → its 429.
export async function POST(request: Request) {
  try {
    const _r = await proxyToFastapi(request, '/api/v2/push/diagnostics');
    if (!_r.ok) return _r;
    return new Response(null, { status: 204 });
  } catch (error) { return handleApiError(error); }
}
