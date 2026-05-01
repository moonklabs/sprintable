import { apiError } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

export async function GET(request: Request) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Not available in OSS mode.', 501);
  return proxyToFastapi(request, '/api/v2/agent-routing-rules');
}

export async function POST(request: Request) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Not available in OSS mode.', 501);
  return proxyToFastapi(request, '/api/v2/agent-routing-rules');
}

export async function PATCH(request: Request) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Not available in OSS mode.', 501);
  return proxyToFastapi(request, '/api/v2/agent-routing-rules');
}
