import { proxyToFastapi } from '@/lib/fastapi-proxy';

// GET /api/workflow-recipes → FastAPI GET /api/v2/workflow-recipes (E-LOOP-LEDGER S18).
// Raw passthrough (loops.ts convention) — BE returns a raw RecipeResponse[], no {data} envelope.
export async function GET(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/workflow-recipes');
}
