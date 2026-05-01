import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { RetroSessionService } from '@/services/retro-session';
import { isOssMode } from '@/lib/storage/factory';
import { addOssRetroAction } from '@/lib/oss-retro';

type RouteParams = { params: Promise<{ id: string }> };

// GET /api/retro-sessions/:id/actions?project_id=X
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    if (!projectId) return ApiErrors.badRequest('project_id required');

    const dbClient = undefined;
    const service = new RetroSessionService(dbClient);
    const data = await service.listActions(id, projectId);
    return apiSuccess(data);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

// POST /api/retro-sessions/:id/actions
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    if (!projectId) return ApiErrors.badRequest('project_id required');

    const body = await request.json() as { title?: string; assignee_id?: string | null };
    if (!body.title) return ApiErrors.badRequest('title required');

    if (isOssMode()) {
      const data = await addOssRetroAction({ session_id: id, project_id: projectId, title: body.title, assignee_id: body.assignee_id ?? null });
      return apiSuccess(data);
    }

    const dbClient = undefined;
    const service = new RetroSessionService(dbClient);
    const data = await service.addAction({ session_id: id, project_id: projectId, title: body.title, assignee_id: body.assignee_id ?? null });
    return apiSuccess(data);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
