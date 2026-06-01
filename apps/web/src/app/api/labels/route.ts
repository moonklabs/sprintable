import { proxyToFastapi } from '@/lib/fastapi-proxy';

export async function GET(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/labels');
}

export async function POST(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/labels');
}
