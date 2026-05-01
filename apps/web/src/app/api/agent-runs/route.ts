
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// POST /api/agent-runs
export async function POST(request: Request) {
  return proxyToFastapi(request, '/api/v2/agent-runs');
}

// GET /api/agent-runs?project_id=X&limit=N
export async function GET(request: Request) {
  return proxyToFastapi(request, '/api/v2/agent-runs');
}
