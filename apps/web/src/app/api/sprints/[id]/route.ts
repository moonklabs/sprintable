

import { SprintService } from '@/services/sprint';
import { handleApiError } from '@/lib/api-error';
import { parseBody, updateSprintSchema } from '@sprintable/shared';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { createSprintRepository } from '@/lib/storage/factory';

type RouteParams = { params: Promise<{ id: string }> };

// GET /api/sprints/:id
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = undefined;

    const repo = await createSprintRepository();
    const service = new SprintService(repo, dbClient as any | undefined);
    const sprint = await service.getById(id);
    return apiSuccess(sprint);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

// PATCH /api/sprints/:id
export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = undefined;

    const parsed = await parseBody(request, updateSprintSchema);
    if (!parsed.success) return parsed.response;
    const repo = await createSprintRepository();
    const service = new SprintService(repo, dbClient as any | undefined);
    const sprint = await service.update(id, parsed.data);
    return apiSuccess(sprint);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

// DELETE /api/sprints/:id
export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = undefined;

    const repo = await createSprintRepository();
    const service = new SprintService(repo, dbClient as any | undefined);
    await service.delete(id);
    return apiSuccess({ ok: true });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
