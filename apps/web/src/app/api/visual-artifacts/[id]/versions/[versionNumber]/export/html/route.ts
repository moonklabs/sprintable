import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; versionNumber: string }> };

/** POST /api/visual-artifacts/{id}/versions/{versionNumber}/export/html — E-CANVAS C1-S5. */
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id, versionNumber } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapi(request, `/api/v2/visual-artifacts/${id}/versions/${versionNumber}/export/html`);
    if (!_r.ok) return _r;
    const json = (await _r.json()) as { data?: unknown };
    return apiSuccess(json.data ?? null, undefined, 201);
  } catch (err: unknown) { return handleApiError(err); }
}
