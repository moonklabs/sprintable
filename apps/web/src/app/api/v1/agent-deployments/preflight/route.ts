import { proxyToFastapi } from '@/lib/fastapi-proxy';

export async function POST(request: Request) {
  return proxyToFastapi(request, '/api/v2/agent-deployments/preflight');
}
