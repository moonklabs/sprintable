import { proxyToFastapi } from '@/lib/fastapi-proxy';

// POST /api/organizations
export async function POST(request: Request) {
  return proxyToFastapi(request, '/api/v2/organizations');
}
