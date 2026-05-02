import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { isOssMode, createStoryRepository } from '@/lib/storage/factory';
import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { StoryService } from '@/services/story';

export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    if (isOssMode()) {
      const { searchParams } = new URL(request.url);
      const projectId = searchParams.get('project_id');
      if (!projectId) return ApiErrors.badRequest('project_id required');
      const repo = await createStoryRepository();
      const service = new StoryService(repo, undefined as any);
      const stories = await service.backlog(projectId);
      return apiSuccess(stories);
    }

    // FastAPI에서 status=backlog 필터로 처리
    const url = new URL(request.url);
    if (!url.searchParams.get('status')) url.searchParams.set('status', 'backlog');
    const modified = new Request(url.toString(), request);
    const _r = await proxyToFastapi(modified, '/api/v2/stories');
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
