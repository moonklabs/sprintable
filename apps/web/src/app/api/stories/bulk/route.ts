import { parseBody, bulkUpdateStorySchema } from '@sprintable/shared';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { StoryService } from '@/services/story';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';

// PATCH /api/stories/bulk — 벌크 수정 (칸반 드래그앤드롭용)
export async function PATCH(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;

    const parsed = await parseBody(request, bulkUpdateStorySchema); if (!parsed.success) return parsed.response; const body = parsed.data;
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return ApiErrors.badRequest('items array required');
    }

    const service = new StoryService(dbClient);
    const results = await service.bulkUpdate(body.items);
    return apiSuccess(results);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
