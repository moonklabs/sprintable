import { updateEpicSchema } from '@sprintable/shared';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { EpicService } from '@/services/epic';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { createEpicRepository } from '@/lib/storage/factory';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;
    const repo = await createEpicRepository(dbClient);
    const service = new EpicService(repo);
    return apiSuccess(await service.getByIdWithStories(id, { org_id: me.org_id, project_id: me.project_id }));
  } catch (err: unknown) { return handleApiError(err); }
}

export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;

    let rawBody: unknown;
    try { rawBody = await request.json(); } catch { return apiError('BAD_REQUEST', 'Invalid JSON body', 400); }
    if (!rawBody || typeof rawBody !== 'object') return apiError('BAD_REQUEST', 'Body must be an object', 400);
    const parsed = updateEpicSchema.safeParse(rawBody);
    if (!parsed.success) return apiError('VALIDATION_ERROR', JSON.stringify(parsed.error.issues), 400);

    const repo = await createEpicRepository(dbClient);
    const service = new EpicService(repo);
    return apiSuccess(await service.update(id, parsed.data));
  } catch (err: unknown) { return handleApiError(err); }
}

export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;
    const repo = await createEpicRepository(dbClient);
    const service = new EpicService(repo);
    await service.delete(id, me.org_id);
    return apiSuccess({ ok: true });
  } catch (err: unknown) { return handleApiError(err); }
}
