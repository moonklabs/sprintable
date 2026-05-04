import { apiSuccess } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const _r = await proxyToFastapi(request, `/api/v2/agent-runs/${id}`);
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
  } catch (error) { return handleApiError(error); }
}

export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const _r = await proxyToFastapi(request, `/api/v2/agent-runs/${id}`);
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
  } catch (error) { return handleApiError(error); }
}
