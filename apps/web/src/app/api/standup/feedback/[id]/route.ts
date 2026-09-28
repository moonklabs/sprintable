
import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess } from '@/lib/api-response';

type RouteParams = { params: Promise<{ id: string }> };

// story #4298 — 단건 GET은 걷었다(BE에 단건 피드백 GET이 없어 늘 405 · 호출자 0 · PO 06:35Z). 목록은 /api/standup/feedback.
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
