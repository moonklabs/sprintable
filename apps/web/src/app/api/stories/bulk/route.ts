import { parseBody, bulkUpdateStorySchema } from '@sprintable/shared';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { isOssMode, createStoryRepository } from '@/lib/storage/factory';
import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { StoryService } from '@/services/story';

// PATCH /api/stories/bulk — 벌크 수정 (칸반 드래그앤드롭용)
export async function PATCH(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    if (isOssMode()) {
      const parsed = await parseBody(request, bulkUpdateStorySchema);
      if (!parsed.success) return parsed.response;
      const body = parsed.data;
      if (!Array.isArray(body.items) || body.items.length === 0) {
        return ApiErrors.badRequest('items array required');
      }
      const repo = await createStoryRepository();
      const service = new StoryService(repo, undefined, { isAdminContext: me.type === 'agent' });
      const results = await service.bulkUpdate(body.items);
      return apiSuccess(results);
    }

    const _r = await proxyToFastapi(request, '/api/v2/stories/bulk');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
