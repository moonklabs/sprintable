import { parseBody, bulkUpdateStorySchema } from '@sprintable/shared';
import { StoryService } from '@/services/story';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { createStoryRepository } from '@/lib/storage/factory';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbClient: any = undefined;

// PATCH /api/stories/bulk — 벌크 수정 (칸반 드래그앤드롭용)
export async function PATCH(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const parsed = await parseBody(request, bulkUpdateStorySchema); if (!parsed.success) return parsed.response; const body = parsed.data;
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return ApiErrors.badRequest('items array required');
    }

    const repo = await createStoryRepository();
    const service = new StoryService(repo, dbClient as SupabaseClient | undefined, { isAdminContext: me.type === 'agent' });
    const results = await service.bulkUpdate(body.items);
    return apiSuccess(results);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
