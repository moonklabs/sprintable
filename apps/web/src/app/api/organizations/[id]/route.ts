import { proxyToFastapi } from '@/lib/fastapi-proxy';

/** DELETE /api/organizations/[id] */
export async function DELETE(request: Request) {
  return proxyToFastapi(request, '/api/v2/organizations');
}
