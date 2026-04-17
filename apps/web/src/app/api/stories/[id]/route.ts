import { parseBody, updateStorySchema } from '@sprintable/shared';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { StoryService } from '@/services/story';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const serviceClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;

    const service = new StoryService(serviceClient);
    const story = await service.getByIdWithDetails(id);

    // Agent scope 검증: cross-project 접근 차단
    if (me.type === 'agent' && story.project_id !== me.project_id) {
      return ApiErrors.forbidden('Forbidden: cross-project access not allowed');
    }

    return apiSuccess(story);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;

    const parsed = await parseBody(request, updateStorySchema); if (!parsed.success) return parsed.response; const body = parsed.data;
    const service = new StoryService(dbClient);
    const story = await service.update(id, body);
    return apiSuccess(story);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;

    const service = new StoryService(dbClient);
    await service.delete(id);
    return apiSuccess({ ok: true });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
