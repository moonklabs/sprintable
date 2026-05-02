

import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { SprintService, NotFoundError } from '@/services/sprint';
import { isOssMode, createSprintRepository } from '@/lib/storage/factory';

type RouteParams = { params: Promise<{ id: string }> };

// POST /api/sprints/:id/kickoff
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const ossMode = isOssMode();
    const dbClient = undefined;

    const body = await request.json().catch(() => ({})) as { message?: string };
    const repo = await createSprintRepository(dbClient);
    const service = new SprintService(repo, dbClient);
    const data = await service.kickoff(id, body.message);
    return apiSuccess(data);
  } catch (err: unknown) {
    if (err instanceof NotFoundError) return ApiErrors.notFound(err.message);
    return handleApiError(err);
  }
}
