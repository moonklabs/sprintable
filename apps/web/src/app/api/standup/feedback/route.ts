
import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess } from '@/lib/api-response';

export async function GET(request: Request) {
  try {
    const _r = await proxyToFastapi(request, '/api/v2/standups/feedback');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

export async function POST(request: Request) {
  try {
    const _r = await proxyToFastapi(request, '/api/v2/standups/feedback');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
