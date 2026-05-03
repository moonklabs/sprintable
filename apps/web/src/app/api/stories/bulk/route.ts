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
      const service = new StoryService(repo, undefined as any, { isAdminContext: me.type === 'agent' });

      // activity log를 위해 변경 전 상태 수집
      const befores = await Promise.all(body.items.map((item) => service.getById(item.id).catch(() => null)));

      const results = await service.bulkUpdate(body.items);

      // status 변경 activity log
      for (let i = 0; i < body.items.length; i++) {
        const item = body.items[i]!;
        const before = befores[i];
        if (item.status && before && item.status !== before.status) {
          service.logActivity({ story_id: item.id, org_id: me.org_id, actor_id: me.id, action_type: 'status_changed', old_value: before.status as string, new_value: item.status }).catch(() => {});
        }
      }

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
