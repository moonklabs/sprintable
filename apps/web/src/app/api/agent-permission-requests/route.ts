import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4533 — GET /api/v2/agent-permission-requests proxy: the agent permission requests sent to me (the approvals inbox's top
// group). The web only looks — answering is the phone's (a signed blob the browser cannot make).
export async function GET(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/agent-permission-requests');
}
