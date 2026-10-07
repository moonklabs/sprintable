import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; host: string }> };

/** DELETE /api/agents/[id]/run-profile/allowed-hosts/[host] — story #4580: [빼기] on the agent's «허용 주소» list (immediate · idempotent) */
export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const { id, host } = await params;
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapi(request, `/api/v2/agents/${id}/run-profile/allowed-hosts/${encodeURIComponent(host)}`);
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}
