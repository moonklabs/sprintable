
import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess } from '@/lib/api-response';

type RouteParams = { params: Promise<{ id: string }> };

// GET /api/standup/feedback/:entry_id — list all feedback for a standup entry
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const _r = await proxyToFastapi(request, `/api/v2/standups/feedback/${id}`);
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const _r = await proxyToFastapi(request, `/api/v2/standups/feedback/${id}`);
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const _r = await proxyToFastapi(request, `/api/v2/standups/feedback/${id}`);
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
