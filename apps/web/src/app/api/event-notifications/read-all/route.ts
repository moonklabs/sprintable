import { proxyToFastapi } from '@/lib/fastapi-proxy';

export async function PATCH(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/event-notifications/read-all');
}
