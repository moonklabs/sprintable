import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { isOssMode } from '@/lib/storage/factory';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';
import { getOssRetroSession, listOssRetroItems, listOssRetroActions, advanceOssRetroPhase } from '@/lib/oss-retro';
import type { RetroPhase } from '@/lib/oss-retro';

type RouteParams = { params: Promise<{ id: string }> };

// GET /api/retro-sessions/:id?project_id=X
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    if (!projectId) return ApiErrors.badRequest('project_id required');

    if (isOssMode()) {
      const session = await getOssRetroSession(id, projectId);
      if (!session) return ApiErrors.notFound('Session not found');
      const [items, actions] = await Promise.all([
        listOssRetroItems(id, projectId),
        listOssRetroActions(id, projectId),
      ]);
      return apiSuccess({ session, items, actions });
    }

    return proxyToFastapiWithParams(request, '/api/v2/retros/[id]', { id });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

// PATCH /api/retro-sessions/:id — change phase
export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    if (!projectId) return ApiErrors.badRequest('project_id required');

    const body = await request.json() as { phase?: string };
    if (!body.phase) return ApiErrors.badRequest('phase required');

    if (isOssMode()) {
      const data = await advanceOssRetroPhase(id, projectId, body.phase as RetroPhase);
      return apiSuccess(data);
    }

    return proxyToFastapiWithParams(request, '/api/v2/retros/[id]/phase', { id });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
