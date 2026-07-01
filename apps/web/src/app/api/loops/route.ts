import { proxyToFastapi } from '@/lib/fastapi-proxy';

// GET /api/loops → FastAPI GET /api/v2/loops (project_id/status/parent_loop_id/goal_tag/limit query passthrough).
// Raw passthrough (gates.ts convention) — BE returns a raw LoopResponse[], no {data} envelope to unwrap.
export async function GET(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/loops');
}
