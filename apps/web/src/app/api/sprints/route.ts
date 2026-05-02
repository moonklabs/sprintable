

import { SprintService, type CreateSprintInput } from '@/services/sprint';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { createSprintSchema } from '@sprintable/shared';
import { isOssMode, createSprintRepository } from '@/lib/storage/factory';

// POST /api/sprints — 생성
export async function POST(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const ossMode = isOssMode();
    const dbClient = undefined;

    let rawBody: unknown;
    try { rawBody = await request.json(); } catch { return apiError('BAD_REQUEST', 'Invalid JSON body', 400); }
    if (!rawBody || typeof rawBody !== 'object') return apiError('BAD_REQUEST', 'Body must be an object', 400);
    const body = rawBody as Record<string, unknown>;
    if (!body.project_id) body.project_id = me.project_id;
    if (!body.org_id) body.org_id = me.org_id;
    const parsed = createSprintSchema.safeParse(body);
    if (!parsed.success) return apiError('VALIDATION_ERROR', JSON.stringify(parsed.error.issues), 400);
    const repo = await createSprintRepository(dbClient);
    const service = new SprintService(repo, dbClient);
    const sprint = await service.create(parsed.data as CreateSprintInput);
    return apiSuccess(sprint, undefined, 201);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

// GET /api/sprints — 목록
export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const ossMode = isOssMode();
    const dbClient = undefined;

    const { searchParams } = new URL(request.url);
    const repo = await createSprintRepository(dbClient);
    const service = new SprintService(repo, dbClient);
    const sprints = await service.list({
      project_id: searchParams.get('project_id') ?? undefined,
      status: searchParams.get('status') ?? undefined,
    });
    return apiSuccess(sprints);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
