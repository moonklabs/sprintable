

import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { SprintService, NotFoundError } from '@/services/sprint';
import { createSprintRepository } from '@/lib/storage/factory';

type RouteParams = { params: Promise<{ id: string }> };

// GET /api/sprints/:id/burndown
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = undefined;

    const repo = await createSprintRepository();
    const service = new SprintService(repo, dbClient as any | undefined);
    const data = await service.getBurndown(id);
    return apiSuccess(data);
  } catch (err: unknown) {
    if (err instanceof NotFoundError) return ApiErrors.notFound(err.message);
    return handleApiError(err);
  }
}
