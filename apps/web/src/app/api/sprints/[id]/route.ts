import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { SprintService } from '@/services/sprint';
import { handleApiError } from '@/lib/api-error';
import { parseBody, updateSprintSchema } from '@sprintable/shared';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';

type RouteParams = { params: Promise<{ id: string }> };

// GET /api/sprints/:id
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;

    const service = new SprintService(dbClient);
    const sprint = await service.getById(id);
    return apiSuccess(sprint);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

// PATCH /api/sprints/:id
export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;

    const parsed = await parseBody(request, updateSprintSchema);
    if (!parsed.success) return parsed.response;
    const service = new SprintService(dbClient);
    const sprint = await service.update(id, parsed.data);
    return apiSuccess(sprint);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

// DELETE /api/sprints/:id
export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;

    const service = new SprintService(dbClient);
    await service.delete(id);
    return apiSuccess({ ok: true });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
