import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { RetroService } from '@/services/retro';
import type { RetroPhase } from '@/services/retro';

type RouteParams = { params: Promise<{ sprint_id: string }> };

// GET /api/retro/:sprint_id?project_id=X[&org_id=Y&initiator_id=Z]
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { sprint_id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    if (!projectId) return ApiErrors.badRequest('project_id required');

    const dbClient = undefined;
    const service = new RetroService(dbClient);

    const orgId = searchParams.get('org_id') ?? undefined;
    const initiatorId = searchParams.get('initiator_id') ?? undefined;
    if (orgId && initiatorId) {
      const data = await service.getOrCreateBySprintId(projectId, orgId, sprint_id, initiatorId);
      return apiSuccess(data);
    }
    const data = await service.getSessionBySprintId(projectId, sprint_id);
    if (!data) return ApiErrors.notFound('Retro session not found for sprint');
    return apiSuccess(data);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

// PATCH /api/retro/:sprint_id — deprecated (use PATCH /api/retro-sessions/:id/phase)
export async function PATCH(_request: Request, _params: RouteParams) {
  return Response.json({ error: { code: 'GONE', message: 'v1 retro API is removed. Use /api/retro-sessions/:id instead.' } }, { status: 410 });
}
