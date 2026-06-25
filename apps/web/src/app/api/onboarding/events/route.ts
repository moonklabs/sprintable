import { handleApiError } from '@/lib/api-error';
import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

/** POST /api/onboarding/events — OB-4 온보딩 funnel 측정 이벤트 emit (fire-and-forget) */
export async function POST(request: Request) {
  try {
    const _r = await proxyToFastapi(request, '/api/v2/onboarding/events');
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}
