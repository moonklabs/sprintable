import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { apiError } from '@/lib/api-response';

export async function GET(request: Request) {
  return proxyToFastapi(request, '/api/v2/webhooks/config');
}

// Deprecated: use PUT /api/webhooks/config instead (supports project_id scoping)
export async function PUT() {
  return apiError('GONE', 'Use PUT /api/webhooks/config instead.', 410);
}
