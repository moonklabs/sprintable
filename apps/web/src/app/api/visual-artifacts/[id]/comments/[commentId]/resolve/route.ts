import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; commentId: string }> };

/** POST /api/visual-artifacts/{id}/comments/{commentId}/resolve — E-CANVAS C2-S6. */
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id, commentId } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapi(request, `/api/v2/visual-artifacts/${id}/comments/${commentId}/resolve`);
    if (!_r.ok) return _r;
    const json = (await _r.json()) as { data?: unknown };
    return apiSuccess(json.data ?? null);
  } catch (err: unknown) { return handleApiError(err); }
}
