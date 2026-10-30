import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4833 — GET /api/v2/agents/desktop-sessions proxy: the state of every agent the person can open the DM of, in one read (the Today screen's list).
// The web only looks. The one-agent read for the DM header is `[id]/desktop-session`; both come from one rule on the server.
export async function GET(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/agents/desktop-sessions');
}
