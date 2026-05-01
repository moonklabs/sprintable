

import { StoryService } from '@/services/story';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { isOssMode, createStoryRepository } from '@/lib/storage/factory';

export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const ossMode = isOssMode();
    const dbClient = undefined;

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    if (!projectId) return ApiErrors.badRequest('project_id required');

    const repo = await createStoryRepository(dbClient);
    const service = new StoryService(repo, dbClient as any | undefined);
    const stories = await service.backlog(projectId);
    return apiSuccess(stories);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
