import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { isOssMode, createAgentRunRepository } from '@/lib/storage/factory';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  if (isOssMode()) {
    try {
      const { id } = await params;
      const { OSS_ORG_ID, OSS_PROJECT_ID } = await import('@sprintable/storage-sqlite');
      const repo = await createAgentRunRepository();
      const run = await repo.getById(id, OSS_ORG_ID, OSS_PROJECT_ID);
      if (!run) return ApiErrors.notFound('Agent run not found');
      return apiSuccess({ ...run, agent_name: null, tool_audit_trail: [], continuity_debug: null });
    } catch (error) { return handleApiError(error); }
  }
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/agent-runs/${id}`);
}

export async function PATCH(request: Request, { params }: RouteParams) {
  if (isOssMode()) return ApiErrors.badRequest('Not available in OSS mode');
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/agent-runs/${id}`);
}
