import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { isOssMode, createAgentRunRepository } from '@/lib/storage/factory';
import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { getAuthContext } from '@/lib/auth-helpers';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  if (isOssMode()) {
    try {
      const { id } = await params;
      const me = await getAuthContext(request);
      if (!me) return ApiErrors.unauthorized();
      const repo = await createAgentRunRepository();
      const run = await repo.getById(id, me.org_id, me.project_id);
      if (!run) return ApiErrors.notFound('Agent run not found');
      return apiSuccess({ ...run, agent_name: null, tool_audit_trail: [], continuity_debug: null });
    } catch (error) { return handleApiError(error); }
  }
  const { id } = await params;
const _r = await proxyToFastapi(request, `/api/v2/agent-runs/${id}`);
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  return apiSuccess(await _r.json())
}

export async function PATCH(request: Request, { params }: RouteParams) {
  if (isOssMode()) return ApiErrors.badRequest('Not available in OSS mode');
  const { id } = await params;
const _r = await proxyToFastapi(request, `/api/v2/agent-runs/${id}`);
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  return apiSuccess(await _r.json())
}
