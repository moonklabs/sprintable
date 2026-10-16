import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4714 — GET /api/v2/desktop/startable?phone_key_id=… proxy (contract 02d2cf71 §14 ④ · v1.18): the computers THIS phone's key is paired
// with, and on each the agents and the projects that have a folder there — ids and names only, never a path. The web only looks.
export async function GET(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/desktop/startable');
}
