import { parseBody, updateTaskSchema } from '@sprintable/shared';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { TaskService } from '@/services/task';
import { createTaskRepository } from '@/lib/storage/factory';
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
    const dbClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;
    const repo = await createTaskRepository(dbClient);
    const service = new TaskService(repo);
    return apiSuccess(await service.getById(id, { org_id: me.org_id, project_id: me.project_id }));
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
    const parsed = await parseBody(request, updateTaskSchema); if (!parsed.success) return parsed.response; const body = parsed.data;
    const repo = await createTaskRepository(dbClient);
    const service = new TaskService(repo);
    await service.getById(id, { org_id: me.org_id, project_id: me.project_id });
    return apiSuccess(await service.update(id, body));
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
    const repo = await createTaskRepository(dbClient);
    const service = new TaskService(repo);
    const existing = await service.getById(id, { org_id: me.org_id });
    await service.delete(id, existing.org_id);
    return apiSuccess({ ok: true });
  } catch (err: unknown) { return handleApiError(err); }
}
