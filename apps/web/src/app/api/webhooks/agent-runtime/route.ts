import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { apiSuccess, apiError } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';

export async function POST(request: Request) {
  if (isOssMode()) return apiError('NOT_AVAILABLE', 'Not available in OSS mode.', 503);
  const _r = await proxyToFastapi(request, '/api/v2/webhooks/agent-runtime');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
}
