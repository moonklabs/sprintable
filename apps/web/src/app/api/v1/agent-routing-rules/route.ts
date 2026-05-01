import { proxyToFastapi } from '@/lib/fastapi-proxy';

export async function GET(request: Request) {
  return proxyToFastapi(request, '/api/v2/agent-routing-rules');
}

export async function POST(request: Request) {
  return proxyToFastapi(request, '/api/v2/agent-routing-rules');
}

export async function PATCH(request: Request) {
  return proxyToFastapi(request, '/api/v2/agent-routing-rules');
}

export async function PUT(request: Request) {
  return proxyToFastapi(request, '/api/v2/agent-routing-rules');
}

export async function DELETE(request: Request) {
  return proxyToFastapi(request, '/api/v2/agent-routing-rules');
}
