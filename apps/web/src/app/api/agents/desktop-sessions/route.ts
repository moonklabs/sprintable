import { handleApiError } from '@/lib/api-error';
import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4833 — GET /api/v2/agents/desktop-sessions proxy: the state of every agent the person can open the DM of, in one read (the Today screen's list).
// The web only looks. The one-agent read for the DM header is `[id]/desktop-session`; both come from one rule on the server.
// The server says X-Total-Count (the number before its cap of 100) — carried into the response meta as `totalCount`, never dropped (story #3857's rule).
export async function GET(request: Request): Promise<Response> {
  try {
    const _r = await proxyToFastapi(request, '/api/v2/agents/desktop-sessions');
    if (!_r.ok) return _r;
    const data = await _r.json();
    const totalHeader = _r.headers.get('x-total-count');
    return apiSuccess(data, { totalCount: totalHeader !== null && Number.isFinite(Number(totalHeader)) ? Number(totalHeader) : null });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
