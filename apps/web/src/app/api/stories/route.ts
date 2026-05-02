
import { parseBody, createStorySchema } from '@sprintable/shared';

import { StoryService, type CreateStoryInput } from '@/services/story';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { checkResourceLimit } from '@/lib/check-feature';
import { buildCursorPageMeta, parseCursorPageInput } from '@/lib/pagination';
import { isOssMode, createStoryRepository } from '@/lib/storage/factory';

export async function POST(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const ossMode = isOssMode();
    const dbClient = undefined;

    if (!ossMode) {
      const check = await checkResourceLimit(dbClient!, me.org_id, 'max_stories', 'stories');
      if (!check.allowed) return apiError('UPGRADE_REQUIRED', check.reason ?? 'Story limit reached. Upgrade to Team.', 403);
    }

    const rawBody = await request.json();
    if (!rawBody.project_id) rawBody.project_id = me.project_id;
    if (!rawBody.org_id) rawBody.org_id = me.org_id;
    const parsed = createStorySchema.safeParse(rawBody);
    if (!parsed.success) return apiError('VALIDATION_ERROR', JSON.stringify(parsed.error.issues), 400);
    const repo = await createStoryRepository(dbClient);
    const service = new StoryService(repo, dbClient);
    const story = await service.create(parsed.data as CreateStoryInput);
    return apiSuccess(story, undefined, 201);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const ossMode = isOssMode();
    const dbClient = undefined;

    const { searchParams } = new URL(request.url);
    const pageInput = parseCursorPageInput({
      limit: searchParams.get('limit') ? Number(searchParams.get('limit')) : undefined,
      cursor: searchParams.get('cursor'),
    }, { defaultLimit: 50, maxLimit: 100 });
    const repo = await createStoryRepository(dbClient);
    const service = new StoryService(repo, dbClient);
    const stories = await service.list({
      sprint_id: searchParams.get('sprint_id') ?? undefined,
      epic_id: searchParams.get('epic_id') ?? undefined,
      assignee_id: searchParams.get('assignee_id') ?? undefined,
      status: searchParams.get('status') ?? undefined,
      project_id: searchParams.get('project_id') ?? undefined,
      q: searchParams.get('q') ?? undefined,
      unassigned: searchParams.get('unassigned') === 'true' ? true : undefined,
      limit: pageInput.limit,
      cursor: pageInput.cursor,
    });
    const { page, meta } = buildCursorPageMeta(stories, pageInput.limit, 'created_at');
    return apiSuccess(page, meta);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
