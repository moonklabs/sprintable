import { apiError, apiSuccess } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

export async function GET(request: Request) {
  if (isOssMode()) return apiSuccess({ ok: true, skipped: true });
  return proxyToFastapi(request, '/api/v2/agent-deployments');
}

export async function POST(request: Request) {
  if (isOssMode()) return apiSuccess({ ok: true, skipped: true });
  return proxyToFastapi(request, '/api/v2/agent-deployments');
}
