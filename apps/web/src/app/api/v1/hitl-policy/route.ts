import { proxyToFastapi } from '@/lib/fastapi-proxy';

export async function GET(request: Request) {
  return proxyToFastapi(request, '/api/v2/hitl/policy');
}

export async function PATCH(request: Request) {
  return proxyToFastapi(request, '/api/v2/hitl/policy');
}
