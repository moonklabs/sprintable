import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { isOssMode, createStoryRepository } from '@/lib/storage/factory';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';
import { StoryService } from '@/services/story';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    if (isOssMode()) {
      const url = new URL(request.url);
      const limit = url.searchParams.get('limit');
      const cursor = url.searchParams.get('cursor');
      const repo = await createStoryRepository();
      const service = new StoryService(repo, undefined);
      const activities = await service.getActivities(id, {
        limit: limit ? parseInt(limit, 10) : 20,
        cursor: cursor ?? undefined,
      });
      const hasMore = limit && activities.length > parseInt(limit, 10);
      const data = hasMore ? activities.slice(0, -1) : activities;
      const nextCursor = hasMore && data.length > 0 ? (data[data.length - 1] as { created_at?: string })?.created_at : null;
      return apiSuccess(data, { nextCursor });
    }

    const _r = await proxyToFastapiWithParams(request, '/api/v2/stories/[id]/activities', { id });
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
