import { proxyToFastapi } from '@/lib/fastapi-proxy';

// GET /api/loops → FastAPI GET /api/v2/loops (project_id/status/parent_loop_id/goal_tag/limit query passthrough).
// Raw passthrough (gates.ts convention) — BE returns a raw LoopResponse[], no {data} envelope to unwrap.
export async function GET(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/loops');
}

// POST /api/loops → FastAPI POST /api/v2/loops (E-LOOP-LEDGER S16). Raw passthrough — success is
// a raw LoopResponse, LOOP_HYPOTHESIS_REQUIRED(400)/validation errors pass through in the BE's
// {data:null,error:{code,message}} envelope (main.py http_exception_handler) verbatim.
export async function POST(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/loops');
}
