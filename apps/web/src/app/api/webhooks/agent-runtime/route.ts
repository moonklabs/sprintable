import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { apiError } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';

export async function POST(request: Request) {
  if (isOssMode()) return apiError('NOT_AVAILABLE', 'Not available in OSS mode.', 503);
  return proxyToFastapi(request, '/api/v2/webhooks/agent-runtime');
}
