

import { SprintService } from '@/services/sprint';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { createSprintRepository } from '@/lib/storage/factory';

type RouteParams = { params: Promise<{ id: string }> };

// POST /api/sprints/:id/activate — planning→active
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = undefined;

    const repo = await createSprintRepository();
    const service = new SprintService(repo, dbClient as any | undefined);
    const sprint = await service.activate(id);
    return apiSuccess(sprint);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
