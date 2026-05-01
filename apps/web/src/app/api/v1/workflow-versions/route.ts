import { proxyToFastapi } from '@/lib/fastapi-proxy';

export async function GET(request: Request) {
  return proxyToFastapi(request, '/api/v2/workflow-versions');
}

export async function POST(request: Request) {
  return proxyToFastapi(request, '/api/v2/workflow-versions');
}
