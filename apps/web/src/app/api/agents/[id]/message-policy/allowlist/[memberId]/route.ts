import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; memberId: string }> };

/** DELETE /api/agents/[id]/message-policy/allowlist/[memberId] — allowlist 멤버 제거 */
export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const { id, memberId } = await params;
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapi(request, `/api/v2/agents/${id}/message-policy/allowlist/${memberId}`);
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}
